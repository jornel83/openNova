/** One startup policy for desktop-capable Bot; inspection never opens windows. */
export function parseStartArgs(args) {
 const options={ui:true,desktop:true};
 for(const arg of args) {
  if(arg==='--ui')options.ui=true;
  else if(arg==='--no-ui')options.ui=false;
  else if(arg==='--desktop')options.desktop=true; // Compatibility with earlier launchers.
  else if(arg==='--check')options.check=true;
  else if(arg==='--stop')options.stop=true;
  else if(['--help','-h'].includes(arg))options.help=true;
  else throw Error('unknown_option: '+arg);
 }
 if(options.check||options.stop||options.help)options.ui=false;
 return options;
}
