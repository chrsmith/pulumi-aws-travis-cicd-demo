// Project describes a location within a 3rd party service that needs AWS access keys to
// be rotated. For example a CI/CD service's build settings for a particular source code repository.
export interface Project {
    project: string;

    // Location of where the AWS credentials are to be updated. e.g. a file path or secure environment
    // variable for the Travis CI repository.
    accessKeyIDLocation: string;
    secretAccessKeyLocation: string;
}

// Service is the abstraction over a 3rd party CI/CD provider, such as Travis CI, CircleCI, GitLab CI,
// etc.
export interface Service {
    // Validate the provided configuration data. Return any user-facing errors as needed.
    validateConfiguration(config: ServiceConfiguration): string | undefined;
    // Contact the Service and update the AWS credential to all of the impacted projects.
    pushNewCredentials(config: ServiceConfiguration, newKey: string, newKeySecret: string): Promise<void>;
}

// ServiceConfiguration describes the configuration that will be passed to a Service, so that it can
// push out new credentials.
export interface ServiceConfiguration {
    // Access key in order to authenticate with the service. For example, your Travis CI API key.
    accessKey: string;

    // Within the destination, the name of an entity to be updated.
    projects: Project[];
}

// CredentialPusher is an object responsible for pushing new IAM credentials to 3rd parties.
// It is initialized with a configuration object, and does its work by calling push.
export class CredentialPusher {
    constructor(public service: Service, public config: ServiceConfiguration) {
        const validationErr = service.validateConfiguration(config);
        if (validationErr) {
            throw new Error(`validation CredentialPusher configuration: ${validationErr}`);
        }
    }

    public async push(newAccessKeyId: string, newSecretAccessKey: string) {
        await this.service.pushNewCredentials(this.config, newAccessKeyId, newSecretAccessKey);
    }
}