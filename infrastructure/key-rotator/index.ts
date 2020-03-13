// Copyright 2019 Pulumi Corporation. All rights reserved.

import * as pulumi from "@pulumi/pulumi";

import { CredentialPusher } from "./credential-pusher";
import { TravisCIPusher } from "./credential-pusher-travis";
import { AccessKeyRotator } from "./iam-key-rotator";
import { user } from "./user-and-group";

const config = new pulumi.Config();

// A "credential pusher" is the component that will push new AWS IAM credentials out to 3rd parties
// as the older ones get rotated. For demonstration purposes this will update the Travis CI settings
// for the chrsmith/pulumi-aws-travis-cicd-demo repo. But you can imagine another implementation
// that would push the new IAM credentials to GitLab CI, or updating multiple CI/CD pipelines.
const demoTravisCIPusher = new CredentialPusher(
    new TravisCIPusher(),
    {
        accessKey: config.require("travis-ci-token"),
        projects: [
            {
                project: "chrsmith/pulumi-aws-travis-cicd-demo",
                // In the Travis CI configuration for that GitHub repo, there are two
                // environment variables for storing the AWS credentials. So whenever the
                // AWS credentials get rotated, the job's configuration settings will be
                // updated to reflect the new values.
                accessKeyIDLocation: "AWS_ACCESS_KEY_ID",
                secretAccessKeyLocation: "AWS_SECRET_ACCESS_KEY",
            }
        ],
    });

// AccessKeyRotator is a custom Pulumi component that encapsulates the AWS Lambda
// that will run periodically and actually change the IAM User's credentials.
const rotator = new AccessKeyRotator("rotator", {
    interval: config.require("rate"),
    user: user,
    credentialPusher: demoTravisCIPusher,
})

export const userName = user.name;
export const userArn = user.arn;