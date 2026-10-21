import { parse } from 'csv-parse/sync';
import ExcelJS from 'exceljs';
import yauzl from 'yauzl';
import { AppError } from '../../shared/errors.js';
export interface CatalogFile {columns:string[];rows:string[][]}
export const MAX_IMPORT_ROWS=100;
const invalid=(message:string)=>new AppError(422,'CATALOG_FILE_INVALID',message);
async function inspectZip(buffer:Buffer){
  await new Promise<void>((resolve,reject)=>{
    yauzl.fromBuffer(buffer,{lazyEntries:true,validateEntrySizes:true},(error,zip)=>{
      if(error||!zip){reject(invalid('Arquivo XLSX inválido.'));return;}
      let expanded=0,entries=0,done=false;
      const fail=()=>{if(done)return;done=true;zip.close();reject(invalid('Planilha muito grande ou com conteúdo não permitido. Remova macros, vínculos externos e objetos incorporados.'));};
      zip.on('error',fail);zip.on('end',()=>{if(!done){done=true;resolve();}});
      zip.on('entry',(entry:yauzl.Entry)=>{
        if(++entries>1000||entry.isEncrypted()||entry.uncompressedSize>8*1024*1024||/vbaProject|externalLinks|embeddings|\.bin$/i.test(entry.fileName)){fail();return;}
        zip.openReadStream(entry,(err,stream)=>{
          if(err||!stream){fail();return;}
          const inspect=/^xl\/(worksheets\/[^/]+\.xml|sharedStrings\.xml)$/.test(entry.fileName),chunks:Buffer[]=[];
          stream.on('error',fail);stream.on('data',(chunk:Buffer)=>{expanded+=chunk.length;if(inspect)chunks.push(chunk);if(expanded>20*1024*1024){stream.destroy();fail();}});
          stream.on('end',()=>{
            if(done)return;
            if(inspect){const xml=Buffer.concat(chunks).toString('utf8');
              // Bound worksheet coordinates and XML item counts BEFORE ExcelJS allocates row/cell objects.
              if((xml.match(/<(?:\w+:)?row\b/g)?.length??0)>101||(xml.match(/<(?:\w+:)?c\b/g)?.length??0)>3030||(xml.match(/<(?:\w+:)?si\b/g)?.length??0)>3030){fail();return;}
              if(entry.fileName.includes('/worksheets/')){
                for(const match of xml.matchAll(/<(?:\w+:)?row\b[^>]*\br="(\d+)"/g))if(Number(match[1])>101){fail();return;}
                for(const match of xml.matchAll(/\b(?:r|ref)="([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?"/g)){
                  const column=(value:string)=>Array.from(value).reduce((n,ch)=>n*26+ch.charCodeAt(0)-64,0);
                  if(column(match[1]!)>30||Number(match[2])>101||(match[3]&&(column(match[3])>30||Number(match[4])>101))){fail();return;}
                }
                for(const match of xml.matchAll(/<(?:\w+:)?col\b[^>]*\bmax="(\d+)"/g))if(Number(match[1])>30){fail();return;}
              }
            }
            zip.readEntry();
          });
        });
      });zip.readEntry();
    });
  });
}
export async function parseCatalogFile(buffer:Buffer,filename:string):Promise<CatalogFile>{
  if(!buffer.length||buffer.length>5*1024*1024)throw invalid('Selecione um arquivo CSV ou XLSX de até 5 MB.');
  let rows:string[][];
  try{
    if(/\.csv$/i.test(filename)){
      const text=new TextDecoder('utf-8',{fatal:true}).decode(buffer);
      const header=text.replace(/^\uFEFF/,'').split(/\r?\n/,1)[0]??'';
      const delimiter=header.includes(';')?';':header.includes('\t')?'\t':',';
      rows=parse(text,{bom:true,delimiter,skip_empty_lines:true,max_record_size:64000,to:MAX_IMPORT_ROWS+2});
    }else if(/\.xlsx$/i.test(filename)){
      await inspectZip(buffer);const book=new ExcelJS.Workbook();
      await book.xlsx.load(buffer as unknown as Parameters<typeof book.xlsx.load>[0]);
      if(book.worksheets.length!==1)throw invalid('Use uma única planilha por arquivo XLSX.');
      const sheet=book.worksheets[0]!;
      if(sheet.rowCount>MAX_IMPORT_ROWS+1||sheet.columnCount>30)throw invalid('Limite de 100 produtos e 30 colunas por arquivo.');
      rows=[];
      for(let r=1;r<=sheet.rowCount;r++){
        const values:string[]=[];
        for(let col=1;col<=sheet.columnCount;col++){
          const v=sheet.getCell(r,col).value;
          if(v!==null&&typeof v==='object')throw invalid(`Linha ${r}: remova fórmulas, links, datas e objetos. Use apenas valores de texto ou números.`);
          values.push(v==null?'':String(v));
        }rows.push(values);
      }
    }else throw invalid('Formatos aceitos: CSV UTF-8 e XLSX.');
  }catch(error){if(error instanceof AppError)throw error;throw invalid('Não foi possível ler o arquivo. Confira o formato e salve novamente como CSV UTF-8 ou XLSX.');}
  if(rows.length<2||rows.length>MAX_IMPORT_ROWS+1||!rows[0]?.length||rows[0].length>30)throw invalid('O arquivo deve conter cabeçalho e de 1 a 100 produtos, com até 30 colunas.');
  const columns=rows[0].map(c=>c.trim());
  if(columns.some(c=>!c||c.length>100)||new Set(columns.map(c=>c.toLowerCase())).size!==columns.length)throw invalid('Use cabeçalhos preenchidos e sem nomes repetidos.');
  if(rows.some(row=>row.length!==columns.length||row.some(cell=>cell.length>2000)))throw invalid('Confira as colunas: cada célula deve ter até 2.000 caracteres.');
  const result={columns,rows:rows.slice(1).map(row=>row.map(cell=>cell.trim()))};
  if(Buffer.byteLength(JSON.stringify(result))>1_000_000)throw invalid('Conteúdo muito grande. Divida em arquivos menores.');
  return result;
}
export function importCents(value:string):number{
  if(!/^\d{1,7}([.,]\d{1,2})?$/.test(value))throw invalid('Preço/custo inválido. Use 12,90 ou 12.90, sem separador de milhar.');
  const [whole,fraction='']=value.replace(',','.').split('.');const cents=Number(whole)*100+Number(fraction.padEnd(2,'0'));
  if(cents>100_000_000)throw invalid('Preço/custo acima do limite.');return cents;
}
export function errorCsv(rows:{line:number;sku:string;errors:string[]}[]):string{
  const escape=(value:string)=>`"${(/^[=+\-@\t\r]/.test(value.trimStart())?"'":'')+value.replace(/"/g,'""')}"`;
  return '\uFEFF'+[['Linha','SKU','Erros'],...rows.filter(r=>r.errors.length).map(r=>[String(r.line),r.sku,r.errors.join(' · ')])].map(row=>row.map(escape).join(';')).join('\r\n');
}
