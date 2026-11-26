import {createFileReadTool} from '../desktop/file-reader.mjs';
import {createDocumentGenerateTool} from '../documents/generator.mjs';
import {DOCUMENT_SPEC_HELP,DOCUMENT_CLAIMS_HELP} from '../documents/spec.mjs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {readTaskInputBytes} from './frozen-documents.mjs';
export const TASK_DOCUMENT_TOOLS=['document_read','document_generate'];
export const taskDocumentInstructions='这是固定输入研究任务。只用 document_read 读取启动时固定的 PDF/Word/Excel/图片，用 read 读取已固定的文本副本；不从原目录或前台对象补取文件。重复读取同一问题和范围会复用回执。需要生成 Word/PDF 时先用 write 在 .nova-spec/ 下新建一个 .json 底稿，再调用 document_generate，只支持新建。默认输出为任务目录内的文件，任务指定外部交付位置时用其确切绝对路径，不更换目标规避冲突。用户限定单页时只写指定内容，保留必要出处。claims 会在文末排印结论与引文，安排篇幅时算入这部分；报价、决定和原文各呈现一次。任务的调度和验收设置留在任务回执中。按实际回执报告成品，未核对排版时不声称已确认页数。';
export function taskDocumentDefinitions(){
  const fields=createDocumentGenerateTool({})[2];
  const {currentOpen:desktopOnly,...read}=createFileReadTool({})[2];
  return [
    ['document_read','读本任务在启动时冻结的文件；path 只能选输入清单的文件名或路径，current=true 仅指启动时明确指定的当前文件。',read],
    ['document_generate','按已准备的 .nova-spec/ JSON 底稿新建 Word 或 PDF。来源使用本任务的读取回执。'+DOCUMENT_SPEC_HELP+DOCUMENT_CLAIMS_HELP,{
      format:{...fields.format,required:true},specPath:{...fields.specPath,required:true},outputPath:{...fields.outputPath,required:true},expectedTarget:fields.expectedTarget,
    }],
  ];
}
/** Keep the Harness line-window contract, but consume the immutable admission copy. */
export async function readFrozenText(config,file,args){
  const base=join(config.harnessRoot,'packages/fs/tool-fs/lib/types');
  const {buildWindow,formatReadOutput,READ_MAX_LINE_LENGTH,READ_MAX_BYTES}=await import(pathToFileURL(join(base,'read-render.js')));
  const {parseReadArgs,READ_LIMIT}=await import(pathToFileURL(join(base,'read.js')));
  const {offset,limit}=parseReadArgs(args,READ_LIMIT),text=readTaskInputBytes(resolve(config.agentHome,'../../..'),file).toString('utf8');
  const window=await buildWindow([text],{offset,limit,maxLineLength:READ_MAX_LINE_LENGTH,maxBytes:READ_MAX_BYTES},file.sourcePath);
  return {value:{path:file.sourcePath,offset,lines:window.lines,totalLines:window.totalLines},content:[{type:'text',text:formatReadOutput(file.sourcePath,{offset,...window})}]};
}
