/** A physical PDF page, a Word paragraph, a spreadsheet cell and a saved web observation are distinct locators. */
export function citationLocation(ref){
  if(Number.isSafeInteger(ref.page)&&ref.page>0)return '原文件物理页：第 '+ref.page+' 页';
  if(Number.isSafeInteger(ref.locator?.paragraph))return 'Word 正文第 '+ref.locator.paragraph+' 段';
  if(ref.locator?.sheet&&ref.locator?.cell)return '工作表「'+ref.locator.sheet+'」· 单元格 '+ref.locator.cell;
  if(ref.observationId)return '网页观察记录：'+ref.observationId;
  return '';
}
