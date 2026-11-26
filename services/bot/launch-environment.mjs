/** Pass only explicitly supported credentials to the private host process. */
const credentialPaths=new Set(['OPENNOVA_SECRETS_FILE','OPENNOVA_SECRETS','OPENNOVA_ARK_KEY_FILE','OPENNOVA_IMAGE_ARK_KEY_FILE','OPENNOVA_GITHUB_TOKEN_FILE','OPENNOVA_KEYCHAIN_HELPER']);
export function launchEnvironment(source=process.env){
  return Object.fromEntries(Object.entries(source).filter(([name])=>
    (name==='ARK_API_KEY'||credentialPaths.has(name)||!/(KEY|TOKEN|SECRET|PASSWORD)/.test(name))&&!['DSH_HOME','NODE_OPTIONS'].includes(name)));
}
