/** Merge build + runtime env vars for Cloudflare Pages deployment_configs. */
export function pagesEnvVarsRecord(config) {
  const merged = {
    SKIP_DEPENDENCY_INSTALL: "1",
    ...(config.buildEnv ?? {}),
    ...(config.productionEnv ?? {}),
  };
  return Object.fromEntries(
    Object.entries(merged).map(([key, value]) => [key, { type: "plain_text", value: String(value) }]),
  );
}

export function pagesDeploymentConfigs(project, config) {
  const env_vars = pagesEnvVarsRecord(config);
  return {
    ...project.deployment_configs,
    production: {
      ...project.deployment_configs?.production,
      env_vars,
    },
    preview: {
      ...project.deployment_configs?.preview,
      env_vars,
    },
  };
}