// Copyright 2019 Pulumi Corporation. All rights reserved.

import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";

import * as process from "process";

import { CredentialPusher } from "./credential-pusher";

async function listIAMAccessKeys(iam: AWS.IAM, iamUserName: string): Promise<AWS.IAM.AccessKeyMetadata[]> {
    const listReqParams: AWS.IAM.ListAccessKeysRequest = {
        UserName: iamUserName,
    };
    const listReq = iam.listAccessKeys(listReqParams);
    const listResp = await listReq.promise();

    return listResp.AccessKeyMetadata;
}

async function createIAMAccessKey(iam: AWS.IAM, iamUserName: string): Promise<AWS.IAM.AccessKey> {
    const createKeyReq: AWS.IAM.CreateAccessKeyRequest = {
        UserName: iamUserName,
    };
    const createReq = iam.createAccessKey(createKeyReq);
    const createResp = await createReq.promise();

    const newKey = createResp.AccessKey;
    return newKey;
}

async function updateIAMAccessKey(
    iam: AWS.IAM, iamUserName: string, accessKeyId: string, status: AWS.IAM.statusType): Promise<void> {
    const updateReqParams: AWS.IAM.UpdateAccessKeyRequest = {
        UserName: iamUserName,
        AccessKeyId: accessKeyId!,
        Status: status,
    };
    const updateReq = iam.updateAccessKey(updateReqParams);
    await updateReq.promise();
}

async function deleteIAMAccessKey(iam: AWS.IAM, iamUserName: string, accessKeyId: string): Promise<void> {
    const deleteReqParams: AWS.IAM.DeleteAccessKeyRequest = {
        UserName: iamUserName,
        AccessKeyId: accessKeyId!,
    };
    const deleteReq = iam.deleteAccessKey(deleteReqParams);
    await deleteReq.promise();
}

// sleep for N seconds. It's an anti-pattern, but since we are dealing with distributed systems, providing
// a small grace period for data to propagate reduces data races.
async function sleepSeconds(n: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, n * 1000));
}

/**
 * This is the actual implementation of our IAM key rotation.
 *
 * The approach is based around two constraints:
 *
 * (1) Each IAM User has a limit of two 2-keys. So we need to delete older, inactive keys shortly
 * after they are rotated. See https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_iam-limits.html
 *
 * (2) We don't invalidate existing keys as soon as we have created new ones, since the older
 * values may still be in-use. e.g. a CI/CD job started before the key was rotated, but doesn't try
 * to use the (previous) key value until after the build/test step has completed.
 *
 * To keep things relatively simple and avoid needing to persist any state, we will rotate keys
 * using the following system. (Assuming that the rotation function is called on a regular interval)
 *
 * 1. List the user's access keys and sort by CreationDate
 * 2. Based on the state of those keys, do one of the following:
 *    2a. If there is zero or one access key, create a new one.
 *
 *        This is the "new" access key that will be distributed to services dependent upon the
 *        rotated credentials. By pushing this out, we assume we will overwrite any refrences to
 *        a previous access key value. (Which would no longer be valid, since presumably it was
 *        deleted in the previous invocation.)
 * 
 *    2b. If there are two access keys, and both are Active, mark the older one as Invalid.
 *
 *        All consumers of the rotated credentials were updated in the previous invocation.
 *        (When a new key was created, bringing the total up to two.) So we can now mark the
 *        previous one as inactive, assuming is is no longer in-use.
 * 
 *        This means that the maximum time a stale key can be used is one-interval.
 * 
 *   2c.  If there are two access keys, and one is Inactive, delete the Inactive  one.
 *
 *        We delete the defunkt access key so that we can repeat the process on the next iteration,
 *        going to step 2a again.
 *
 *        NOTE: This step can be skipped entirely, with 2b simply deleting the oldest access key
 *        instead. Invalidating a key before Deleting it just provides a larger window for diagnosing
 *        problems that may arise from the invalid credentials, as well as potentially more
 *        descriptive error messages.
 * 
 *        By having the Inactive then Delete step, this means that the duration that a access key
 *        is valid is two intervals.
 */
async function rotateIAMUserKeys(iamUser: aws.iam.User, onNewCredentials: (key: string, secret: string) => Promise<void>) {
    try {
        const iamUserName = iamUser.name.get();
        
        // The IAM client library will be authenticated with the current Lambda's execution role,
        // which should be configured with the right permissions to use IAM APIs.
        const iam = new aws.sdk.IAM();

        // Obtain and sort the user's access keys in descending order. Newer keys first.
        let accessKeys = await listIAMAccessKeys(iam, iamUserName);
        accessKeys = accessKeys.sort((a, b) => {
            let aCreation = a.CreateDate!;
            let bCreation = b.CreateDate!;

            if (aCreation > bCreation) return -1;
            if (aCreation < bCreation) return 1;
            return 0;
        });

        console.log(`IAM User has ${accessKeys.length} keys:`);
        for (const key of accessKeys) {
            console.log(` - ${key.AccessKeyId} [${key.Status}] ${key.CreateDate}`);
        }

        if (accessKeys.length > 2) {
            // IAM limits a user to having two access keys. You cannot request an increase
            // to this limit. So we just bail, since this represents an unexpected state.
            throw new Error(`Unexpected number of access keys (${accessKeys.length})`);
        } else if (accessKeys.length <= 1) {
            // If there is only one access key, then create a new one and inform 3rd party services
            // that they should start using it instead of whatever key they had beforehand.
            const newKey = await createIAMAccessKey(iam, iamUserName);
            console.log(`Created new key key ${newKey.AccessKeyId}`);

            // Spread word, heralding the creation of the new key!
            await sleepSeconds(1);
            await onNewCredentials(newKey.AccessKeyId, newKey.SecretAccessKey);
        } else {
            // If we have two access keys, then we need to invalidate or delete the oldest one.
            const olderKey = accessKeys[1];
            switch (olderKey.Status) {
                case "Active":
                    console.log(`Invalidating older access key ${olderKey.AccessKeyId}`);
                    await updateIAMAccessKey(iam, iamUserName, olderKey.AccessKeyId!, "Inactive");
                    break;
                case "Inactive":
                    console.log(`Deleting older, inactive access key ${olderKey.AccessKeyId} [${olderKey.Status}]`);
                    await deleteIAMAccessKey(iam, iamUserName, olderKey.AccessKeyId!);
                    break;
                default:
                    // The status should only be "Active" or "Inactive". So this would represent some
                    // new, and entirely unexpected behavior from AWS.
                    throw new Error(`Unexpected status for access key (${olderKey.Status})`);
            }
        }

        console.log("Key rotation step complete.\n\n\n");
    } catch (err) {
        console.log("Unhandled exception:\n", err);
    }
}

export interface AccessKeyRotatorArgs {
    // IAM User whose credentials will be rotated on a regular schedule.
    user: aws.iam.User;

    // The interval by which the key will be rotated. For example, "rate(1h)" for format see:
    // https://docs.aws.amazon.com/AmazonCloudWatch/latest/events/ScheduledEvents.html#CronExpressions.
    //
    // It is important that the interval is longer than the maximum duration that it would be needed.
    // For example, if you are relying on the access key for a CI job that may take 1-hour to complete,
    // the interval should be 1-hour or more.
    //
    // An access key will be active for 4x intervals after it has been created. But it will only be
    // active for 1x interval after it has been rotated, and replace by its successor. (e.g. the CI
    // system would have been notified to use the newer access key, but any jobs still in progress
    // would have the stale key, which will only be valid for 1x interval longer.)
    interval: string;

    // CredentialPusher instance that will be invoked whenever new IAM credentials are created.
    // This will be serialized into an AWS Lambda, so natrually it shouldn't rely on external
    // state like environment variables.
    credentialPusher: CredentialPusher;
}

// AccessKeyRotator wraps the resources required for rotating an AWS IAM User's access keys on
// a fixed schedule.
export class AccessKeyRotator extends pulumi.ComponentResource {
    public readonly user: aws.iam.User;
    public readonly interval: string;

    constructor(name: string, args: AccessKeyRotatorArgs, opts?: pulumi.ComponentResourceOptions) {
        super("pulumi-eng:apps:AccessKeyRotator", name, opts);

        this.user = args.user;
        this.interval = args.interval;

        // Create the IAM Role Lambda will use.
        const lambdaRole = this.createLambdaRolePolicy(args.user);

        // The AWS lambda that will be triggered periodically.
        const userToRotate = this.user;  // Cannot capture this inside closure...
        const lambda = new aws.lambda.CallbackFunction<aws.cloudwatch.EventRuleEvent, void>(
            "keyRotatorLambda",
            {
                callback: async (e) => {
                    await rotateIAMUserKeys(userToRotate, async (newKey: string, newSecret: string) => {
                        try {
                            console.log("Pushing out the new key to 3rd party services...");
                            await args.credentialPusher.push(newKey, newSecret);
                        } catch (err) {
                            console.log("Unhandled exception pushing out credentials:");
                            console.log(err);
                        }
                    });
                },
                role: lambdaRole,
                runtime: "nodejs10.x",

                tags: {
                    "Owner": process.env["USER"],
                    "IAM User": this.user.arn,
                }
            },
            {
                parent: this,
            });


        // Schedule our Lambda to be invoked regularly.
        const triggerSchedule = aws.cloudwatch.onSchedule(
            "keyRotatorScheduler", this.interval, lambda, {}, { parent: this });

        this.registerOutputs({});
    }

    // Creates the IAM Role policy to be used by AWS Lambda so that it has the permissions
    // necessary to rotate the IAM User's credentials.
    private createLambdaRolePolicy(user: aws.iam.User): aws.iam.Role {
        // Create the IAM Role. Allow the AWS Lambda to assume it.
        const lambdaRole = new aws.iam.Role("lambdaRole", {
            assumeRolePolicy: {
                Version: "2012-10-17",
                Statement: [
                    {
                    Action: "sts:AssumeRole",
                    Principal: {
                        Service: "lambda.amazonaws.com"
                    },
                    Effect: "Allow",
                    Sid: ""
                    }
                ]
            },
        }, {
            parent: this,
        });

        // Lambda execution policy, enabling the APIs to rotate credentials for the specific IAM User.
        const keyRotatorPolicy = new aws.iam.Policy("lambdaKeyRotationPolicy", {
            description: "Allow full control of the IAM user's access keys.",
            policy: {
                Version: "2012-10-17",
                Statement: [
                    {
                        Effect: "Allow",
                        Action: [
                            "iam:CreateAccessKey",
                            "iam:DeleteAccessKey",
                            "iam:ListAccessKeys",
                            "iam:UpdateAccessKey",
                        ],
                        Resource: user.arn,
                    },
                ],
            },
        }, {
            parent: this,
        });

        // Attach IAM policies to the role.
        const attachment1 = new aws.iam.RolePolicyAttachment("lambdaKeyRotationPolicyAttachment", {
            role: lambdaRole,
            policyArn: keyRotatorPolicy.arn,
        }, {
            parent: lambdaRole,
        });
        // Attach the basic execution role so that Lambda can write logs.
        const attachment2 = new aws.iam.RolePolicyAttachment("lambdaKeyRotationExPolicyAttachment", {
            role: lambdaRole,
            policyArn: "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
        }, {
            parent: lambdaRole,
        });

        return lambdaRole;
    }
}