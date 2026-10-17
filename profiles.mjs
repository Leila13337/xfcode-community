import {createHash} from 'node:crypto';

export function installProfiles({db,send,errors,requireUser,jsonBody,publicUser}) {
 db.exec(`CREATE TABLE IF NOT EXISTS user_profiles (user_id INTEGER PRIMARY KEY REFERENCES users(id), avatar BLOB, avatar_version TEXT, contacts TEXT NOT NULL DEFAULT '{}')`);
 const fields={qq:40,wechat:80,phone:40,email:254,telegram:80,website:500};
 function contacts(id){return JSON.parse(db.prepare('SELECT contacts FROM user_profiles WHERE user_id=?').get(id)?.contacts||'{}');}
 async function handle(req,res,url,session){
  const route=url.pathname;
  if(route.startsWith('/avatars/')){
   requireUser(session);if(!['GET','HEAD'].includes(req.method))throw errors(405,'不支持此请求方式。');
   const id=route.match(/^\/avatars\/(\d+)$/)?.[1];const row=id?db.prepare('SELECT avatar FROM user_profiles WHERE user_id=?').get(id):null;
   if(!row?.avatar)throw errors(404,'头像不存在。');
   res.writeHead(200,{'Content-Type':'image/jpeg','Content-Length':row.avatar.length,'Cache-Control':'private, no-store'});res.end(req.method==='HEAD'?undefined:Buffer.from(row.avatar));return true;
  }
  if(req.method!=='POST'||!['/api/profile','/api/profile/avatar'].includes(route))return false;
  const id=requireUser(session);const body=await jsonBody(req);if(!body||typeof body!=='object'||Array.isArray(body))throw errors(400,'资料格式不正确。');
  const target=url.searchParams.get('id')??body.user_id;if(target!==undefined&&target!==null&&String(target)!==String(id))throw errors(403,'只能修改自己的资料。');
  if(route==='/api/profile'){
   const values={};for(const [key,max]of Object.entries(fields)){const value=body[key]??'';if(typeof value!=='string'||value.length>max||/[\x00-\x1f]/.test(value))throw errors(400,'联系方式格式或长度不正确。');values[key]=value.trim();}
   if(values.email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email))throw errors(400,'请输入有效的联系邮箱。');
   if(values.website){let parsed;try{parsed=new URL(values.website);}catch{throw errors(400,'请输入以 http:// 或 https:// 开头的网站地址。');}if(!['http:','https:'].includes(parsed.protocol))throw errors(400,'网站地址只支持 http:// 或 https://。');}
   db.prepare('INSERT INTO user_profiles(user_id,contacts) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET contacts=excluded.contacts').run(id,JSON.stringify(values));send(res,200,{contacts:values});return true;
  }
  if(body.image===null){db.prepare('UPDATE user_profiles SET avatar=NULL,avatar_version=NULL WHERE user_id=?').run(id);send(res,200,{user:publicUser(id)});return true;}
  if(typeof body.image!=='string'||!/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(body.image))throw errors(400,'头像格式无效，请重新选择图片。');
  const bytes=Buffer.from(body.image.split(',')[1],'base64');
  if(bytes.length>48*1024||bytes.length<4||bytes[0]!==255||bytes[1]!==216||bytes[2]!==255||bytes.at(-2)!==255||bytes.at(-1)!==217)throw errors(400,'头像数据无效，请重新选择图片。');
  const version=createHash('sha256').update(bytes).digest('hex').slice(0,16);
  db.prepare('INSERT INTO user_profiles(user_id,avatar,avatar_version) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET avatar=excluded.avatar,avatar_version=excluded.avatar_version').run(id,bytes,version);
  send(res,200,{user:publicUser(id)});return true;
 }
 return {handle,contacts};
}
