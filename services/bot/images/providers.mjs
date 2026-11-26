export const sparkImageModel='minimax-h3-image';

export function usesSparkImage(args){
  return args?.provider==='spark'||args?.model===sparkImageModel;
}

export function hasSparkImageJob(generation){
  return generation?.provider==='spark'&&generation.model===sparkImageModel&&
    typeof generation.taskId==='string'&&/^h3-image-[a-f0-9]{32}$/.test(generation.taskId);
}

/** Only these operations have a provider job that the host can follow. */
export function hasRemoteMediaJob(record,generation=record?.generation){
  if(record?.name==='image_generate')return hasSparkImageJob(generation);
  return record?.name==='gif_generate'&&typeof generation?.taskId==='string'&&/^[A-Za-z0-9_-]{1,200}$/.test(generation.taskId);
}
