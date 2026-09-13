export interface OauthCeremonyState {
  completed: boolean;
}

export const shouldReuseOauthCache = (env: NodeJS.ProcessEnv, state: OauthCeremonyState): boolean =>
  state.completed || env["AQUA_OAUTH_REUSE_CACHE"] === "1";
