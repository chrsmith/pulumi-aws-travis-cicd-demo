import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";

// Create an AWS IAM User that will be used to deploy stack updates in your CI/CD system.
export const user = new aws.iam.User("cicdUser", {
    name: "cicd-bot",
    path: "/bots/",
    tags: {
        "purpose": "Account used to perform Pulumi stack updates on CI/CD.",
        "pulumi-stack": `${pulumi.getProject()}/${pulumi.getStack()}`,
    }
});

// Create an IAM Group that will grant permissions to its users. This is recommended over
// granting access to an IAM User resource directly.
const group = new aws.iam.Group("pulumiStackUpdaters", {
    name: "PulumiStackUpdaters",
});

// And add our user!
const groupMembership = new aws.iam.GroupMembership("cicdUserMembership", {
    group: group.name,
    users: [ user.name ],
});

const currentAwsIdentity = aws.getCallerIdentity();
// Now we declare the permissions granted to the members of the group. This is intentionally
// limited. We don't want to grat the newly created IAM User access to update cloud resources.
// We only want to give them the ability to "assume an IAM Role" that does have the permissions.
const groupPolicy = new aws.iam.GroupPolicy("pulumiStackUpdatersPolicy", {
    group: group.name,
    policy: {
        Version: "2012-10-17",
        Statement: [{
            Action: [
                // Allow anybody (i.e. members of the group) to call the sts:AssumeRole API.
                // This will allow them to "assume the role" of a more permissive IAM Role
                // when they go to update a stack later.
                "sts:AssumeRole",
            ],
            Effect: "Allow",
            // This is the set of resources that the "sts:AssumeRole" operation could be
            // performed on, which is to say any IAM role in the current AWS account.
            Resource: pulumi.interpolate `arn:aws:iam::${currentAwsIdentity.accountId}:role/*`,
            Sid: ""
        }],
    },
});
