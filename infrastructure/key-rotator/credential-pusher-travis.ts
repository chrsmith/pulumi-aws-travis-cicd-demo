import * as axios from "axios";

import { Service, ServiceConfiguration } from "./credential-pusher";

/**
 * Implementation of a Credential Pusher that pushes credentials to
 * Travis CI projects.
 * http://travis-ci.com
 */

// Types from the Travis API
// https://developer.travis-ci.com/resource/env_var#Env%20var
interface TravisListEnvVarsResponse {
    env_vars: TravisEnvVar[];
}

interface TravisEnvVar {
    id?: string;
    name?: string;
    public?: boolean;
    value?: string;
}

export class TravisCIPusher implements Service {
    validateConfiguration(config: ServiceConfiguration): string | undefined {
        if (!config.accessKey) {
            return "No Travis CI access key provided.";
        }
        if (!config.projects || config.projects.length === 0) {
            return "No projects to push credentials to.";
        }
        return undefined;
    }

    async pushNewCredentials(config: ServiceConfiguration, newAccessKeyId: string, newSecretAccessKey: string) {
        const travisClient = this.getTravisClient(config.accessKey);

        for (const project of config.projects) {
            console.log(`Pushing new credentials to Travis CI project '${project.project}'`);
    
            // The repo slug is baked into the URL, but in order to be URL safe we need to escape
            // owner/repo-name, so that it becomes "owner%2Frepo-name".
            const repoSlug = encodeURIComponent(project.project);
    
            // To update an environment variable we need to get the Travis ID for it. Query all env vars
            // and fine the ones corresponding to the access key ID and secret access key.
            const listEnvVarsResp = await travisClient.get<TravisListEnvVarsResponse>(`/repo/${repoSlug}/env_vars`);
            if (!listEnvVarsResp || !listEnvVarsResp.data || !listEnvVarsResp.data.env_vars) {
                throw new Error("Didn't get list of Travis project credentials as expected.");
            }
            const envVars = listEnvVarsResp.data.env_vars;
    
            let accessKeyEnvVarId = "";
            let secretAccessKeyEnvVarId = "";
            for (const envVar of envVars) {
                if (!envVar.id) continue;
                if (envVar.name === project.accessKeyIDLocation) {
                    accessKeyEnvVarId = envVar.id!;
                } else if (envVar.name === project.secretAccessKeyLocation) {
                    secretAccessKeyEnvVarId = envVar.id!;
                }
            }
            if (!accessKeyEnvVarId) {
                throw new Error(`Unable to find Travis CI environment variable with name ${project.accessKeyIDLocation}`);
            }
            if (!secretAccessKeyEnvVarId) {
                throw new Error(`Unable to find Travis CI environment variable with name ${project.secretAccessKeyLocation}`);
            }
    
            // Update them.
            console.log(`Updating env var '${project.accessKeyIDLocation}' (${accessKeyEnvVarId})`);
            const updateAccessKeyIdResp = await travisClient.patch<TravisListEnvVarsResponse>(
                `/repo/${repoSlug}/env_var/${accessKeyEnvVarId}`,
                {
                    "env_var.value": newAccessKeyId,
                    "env_var.public": true,
                });
            console.log(`Updated AWS access key ID. Got response code (${updateAccessKeyIdResp.status})`);
        
            console.log(`Updating env var '${project.secretAccessKeyLocation}' (${secretAccessKeyEnvVarId})`);
            const updateSecretAccessKeyResp = await travisClient.patch<TravisListEnvVarsResponse>(
                `/repo/${repoSlug}/env_var/${secretAccessKeyEnvVarId}`,
                {
                    "env_var.value": newSecretAccessKey,
                    "env_var.public": false,
                });
            console.log(`Updated AWS secret access key. Got response code (${updateSecretAccessKeyResp.status})`);
        }
    }

    private getTravisClient(token: string): axios.AxiosInstance {
        return axios.default.create({
            baseURL: "https://api.travis-ci.com",
            headers: {
                "Travis-API-Version": "3",
                "Authorization": `token ${token}`,
                "Content-Type": "application/json",
                "User-Agent": "Pulumi AWS access key rotator",
            },
            timeout: 10 * 1000,  // 10s
        });
    }
}
