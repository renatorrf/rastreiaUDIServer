import {describe,it,expect} from 'vitest';
import type {AppEnv} from '../../config/env.js';
import {offerTemplate,stoppedRecipients} from './retention-whatsapp.js';
describe('WhatsApp de ofertas',()=>{
 const message={type:'button',from:'5534999999999',button:{payload:'RETENTION_STOP'}};
 const body=(phone:string,messages:unknown[])=>({object:'whatsapp_business_account',entry:[{changes:[{field:'messages',value:{metadata:{phone_number_id:phone},messages}}]}]});
 it('aceita apenas o botão do remetente configurado e remove duplicatas',()=>{
   expect([...stoppedRecipients(body('r3',[message,message]),'r3')]).toEqual([message.from]);
   expect(stoppedRecipients(body('outra',[message]),'r3').size).toBe(0);
   expect(stoppedRecipients(body('r3',[{...message,button:{payload:'OTHER'}}]),'r3').size).toBe(0);
   expect([...stoppedRecipients(body('r3',[{...message,from:'553499999999'}]),'r3')]).toContain(message.from);
 });
 it('usa quatro variáveis, sufixo de URL e payload de saída separados do rastreio',()=>{
   const payload=offerTemplate({id:'oferta',first_name:'Ana',store_name:'Loja',product_name:'Suco',percent:100,expires_at:new Date(2026,11,10,15),whatsapp:message.from},{WHATSAPP_OFFERS_TEMPLATE:'oferta',WHATSAPP_OFFERS_LANGUAGE:'pt_BR'} as AppEnv);
   expect(payload.template.components[0]?.parameters).toHaveLength(4);
   expect(payload.template.components.slice(1)).toMatchObject([{index:'0',parameters:[{text:'oferta'}]},{index:'1',parameters:[{payload:'RETENTION_STOP'}]}]);
 });
});
