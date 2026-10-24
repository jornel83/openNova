export const httpTool=['web_request',
 '后台获取公开 HTTP GET 数据。支持 Referer 等非凭据请求头及编码。返回真实 HTTP 状态、获取时间、片段和完整受限响应文件；可用脚本读取文件。JavaScript 响应只是文本。',
 {url:{type:'string',required:true},headers:{type:'object',additionalProperties:{type:'string'}},encoding:{type:'string'},responseType:{type:'string',enum:['auto','text','json']}},
 ()=>{throw Error('research_middleware_required');}];
