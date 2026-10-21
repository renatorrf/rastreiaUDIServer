import { describe,expect,it } from 'vitest';
import ExcelJS from 'exceljs';
import sharp from 'sharp';
import { parseCatalogFile,importCents,errorCsv } from './catalog-file.js';
import { optimizeProductImage } from './media.routes.js';
describe('bounded catalog files and sanitized images',()=>{
  it('reads UTF-8 CSV with BOM, quoted commas and leading zero codes',async()=>{
    const file=await parseCatalogFile(Buffer.from('\uFEFFSKU;Nome;Preço\r\n0001;"Café, especial";12,90\r\n'),'produtos.csv');expect(file.rows).toEqual([['0001','Café, especial','12,90']]);
  });
  it('rejects invalid headers, excess rows, broken CSV and wrong extensions',async()=>{
    for(const data of ['SKU;SKU\na;b',';Nome\na;b','SKU;Nome\na;b;c','SKU;Nome\n'+Array(101).fill('x;y').join('\n')])await expect(parseCatalogFile(Buffer.from(data),'file.csv')).rejects.toMatchObject({statusCode:422});
    await expect(parseCatalogFile(Buffer.from('x'),'file.xls')).rejects.toMatchObject({statusCode:422});
  });
  it('reads genuine XLSX and rejects formulas and multiple sheets',async()=>{
    const book=new ExcelJS.Workbook(),sheet=book.addWorksheet('Produtos');sheet.addRows([['SKU','Nome','Preço'],['0001','Café',12.99]]);
    expect((await parseCatalogFile(Buffer.from(await book.xlsx.writeBuffer()),'file.xlsx')).rows).toEqual([['0001','Café','12.99']]);
    sheet.getCell('C2').value={formula:'1+1',result:2};await expect(parseCatalogFile(Buffer.from(await book.xlsx.writeBuffer()),'file.xlsx')).rejects.toMatchObject({statusCode:422});
    sheet.getCell('C2').value=2;book.addWorksheet('Extra');await expect(parseCatalogFile(Buffer.from(await book.xlsx.writeBuffer()),'file.xlsx')).rejects.toMatchObject({statusCode:422});
  });
  it('rejects oversized expanded XLSX before workbook parsing',async()=>{
    const book=new ExcelJS.Workbook(),sheet=book.addWorksheet('Produtos');sheet.addRow(['Nome']);sheet.addRow(['A'.repeat(9*1024*1024)]);
    await expect(parseCatalogFile(Buffer.from(await book.xlsx.writeBuffer()),'file.xlsx')).rejects.toMatchObject({statusCode:422});
  });
  it('parses money without floating point rounding and escapes CSV injection',()=>{
    expect(importCents('19,99')).toBe(1999);expect(importCents('0.01')).toBe(1);
    for(const value of ['-1','1e3','1.234,56','0.999','=2+2'])expect(()=>importCents(value)).toThrow();
    expect(errorCsv([{line:2,sku:'=HYPERLINK("bad")',errors:['erro']}])).toContain("'=HYPERLINK");
  });
  it('decodes genuine photos, resizes and strips metadata',async()=>{
    const source=await sharp({create:{width:1800,height:1000,channels:3,background:'#39cc85'}}).jpeg().withMetadata().toBuffer();
    const image=await optimizeProductImage(source),meta=await sharp(image.data).metadata();expect(image.width).toBe(1600);expect(meta.format).toBe('webp');expect(meta.exif).toBeUndefined();expect((await sharp(image.thumbnail).metadata()).width).toBe(400);
  });
  it('rejects SVG disguised as a photo, corrupt and excessive images',async()=>{
    for(const data of [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>'),Buffer.from('not a photo'),Buffer.alloc(5*1024*1024+1)])await expect(optimizeProductImage(data)).rejects.toBeTruthy();
  });
});
