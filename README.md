# AWS Credential Rotator 9000

Pulumi application for regularly rotating an AWS IAM User's access keys.

Standing up the Pulumi program will:

- Create a new AWS IAM User named `cicd-bot`
- Create a new AWS IAM Group named "PulumiStackUpdaters" (with `cicd-bot` as a member)

Then, it will stand up an AWS Lambda that will be invoked on a regular interval which will
rotate that user's AWS credentials. Every N minutes, the oldest active access key will be
marked as invalid. And the oldest inactive access key will be deleted.

See the source for the specific process. But in-short, as long as your CI/CD jobs will
take no more than N minutes, everything should work out.

When a new AWS access key is creator, the key will be pushed to a 3rd party service.
In the code here, it will update Travis CI job environment variables to include the new
access key ID and secret. (But could easily be extended to support pushing credentials
to other services.

## Demoware Disclaimer

This Pulumi application is demoware. It should be fairly easy to configure and standup
for your own purposes, but there are plenty of bells and whistles that would make it
more amenable for "turn key" reuse.

If you stand this up for your team or company, please feel free to send pull requests
so others can benefit from your additions.

If you have questions, feel free to contact me (`@Chris Smith`) on the
[Pulumi Community Slack](https://slack.pulumi.com)
