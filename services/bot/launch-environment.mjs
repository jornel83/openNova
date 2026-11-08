/** Pass only explicitly supported credentials to the private host process. */
export function launchEnvironment(source=process.env){
  return Object.fromEntries(Object.entries(source).filter(([name])=>
    (name==='ARK_API_KEY'||!/(KEY|TOKEN|SECRET|PASSWORD)/.test(name))&&!['DSH_HOME','NODE_OPTIONS'].includes(name)));
}
