import { randomBytes, createHash } from 'node:crypto';
import { mkdir, readFile, stat, unlink, open } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';

export async function installFeatures(ctx) {
 const {db,DATA,send,errors,now,publicUser,requireUser,jsonBody,text,hashToken,currentSession}=ctx;
 const DAY=86400000;
 const plans=['xfgrok','xfcodex','xfclaude'].flatMap(product=>[30,90,365].map(days=>({id:product+'-'+days,product,name:product+' '+days+' 天',days})));
 const legacyPlans=[{id:'monthly',name:'原月度套餐',days:30},{id:'quarterly',name:'原季度套餐',days:90},{id:'yearly',name:'原年度套餐',days:365}];
 db.exec("CREATE TABLE IF NOT EXISTS user_roles (user_id INTEGER PRIMARY KEY REFERENCES users(id), role TEXT NOT NULL); CREATE TABLE IF NOT EXISTS memberships (user_id INTEGER PRIMARY KEY REFERENCES users(id), expires INTEGER NOT NULL DEFAULT 0, trial_used INTEGER NOT NULL DEFAULT 0, updated INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS subscription_orders (id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), plan TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created INTEGER NOT NULL, activated INTEGER); CREATE TABLE IF NOT EXISTS subscription_codes (id INTEGER PRIMARY KEY, hash TEXT UNIQUE NOT NULL, tail TEXT NOT NULL, plan TEXT NOT NULL, created_by INTEGER NOT NULL REFERENCES users(id), created INTEGER NOT NULL, redeemed_by INTEGER REFERENCES users(id), redeemed INTEGER); CREATE TABLE IF NOT EXISTS subscription_events (id INTEGER PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id),source TEXT NOT NULL,plan TEXT NOT NULL,days INTEGER NOT NULL,expires INTEGER NOT NULL,created INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS releases (id INTEGER PRIMARY KEY,title TEXT NOT NULL,version TEXT NOT NULL,filename TEXT NOT NULL,disk_name TEXT NOT NULL UNIQUE,size INTEGER NOT NULL,sha256 TEXT NOT NULL,notes TEXT NOT NULL,members_only INTEGER NOT NULL DEFAULT 1,created INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS download_events (id INTEGER PRIMARY KEY,release_id INTEGER NOT NULL REFERENCES releases(id),user_id INTEGER REFERENCES users(id),created INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS chat_messages (id INTEGER PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id),body TEXT NOT NULL,created INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS forum_aliases (old_id INTEGER PRIMARY KEY,new_id INTEGER NOT NULL REFERENCES forums(id)); CREATE INDEX IF NOT EXISTS chat_created_idx ON chat_messages(created); CREATE UNIQUE INDEX IF NOT EXISTS one_pending_order ON subscription_orders(user_id) WHERE status='pending';");
 // Merge every existing discussion into one forum without changing topic or post ids.
 db.exec('BEGIN');
 try {
  if(!db.prepare('SELECT id FROM forums WHERE id=2').get())db.prepare('INSERT INTO forums(id,category,name,description,icon,sort) VALUES(2,?,?,?,?,?)').run('社区','社区','公告、交流与帮助，都在这里。','chat',1);
  for(const f of db.prepare('SELECT id FROM forums WHERE id<>2').all())db.prepare('INSERT OR REPLACE INTO forum_aliases VALUES(?,2)').run(f.id);
  db.exec("UPDATE topics SET forum_id=2; DELETE FROM forums WHERE id<>2; UPDATE forums SET category='社区',name='社区',description='公告、交流与帮助，都在这里。',icon='chat',sort=1 WHERE id=2;");
  db.exec('COMMIT');
 }catch(error){db.exec('ROLLBACK');throw error;}
 function ensureOwner(){if(!db.prepare("SELECT 1 FROM user_roles WHERE role='administrator'").get()){const first=db.prepare("SELECT id FROM users WHERE password<>'' AND disabled=0 ORDER BY id LIMIT 1").get();if(first)db.prepare("INSERT OR REPLACE INTO user_roles VALUES(?,'administrator')").run(first.id);}}
 ensureOwner();
 function requireAdmin(session){const id=requireUser(session);if(db.prepare('SELECT role FROM user_roles WHERE user_id=?').get(id)?.role!=='administrator')throw errors(403,'需要管理员权限。');return id;}
 function member(id){const m=id?db.prepare('SELECT * FROM memberships WHERE user_id=?').get(id):null;return {active:Boolean(m&&m.expires>now()),expires:m?.expires||null};}
 function plan(id,allowLegacy=false){const p=plans.find(x=>x.id===id)||(allowLegacy?legacyPlans.find(x=>x.id===id):null);if(!p)throw errors(400,'请选择有效的订阅套餐。');return p;}
 function extend(userId,days,source,planId){const old=db.prepare('SELECT * FROM memberships WHERE user_id=?').get(userId);const expires=Math.max(now(),old?.expires||0)+days*DAY;db.prepare('INSERT INTO memberships(user_id,expires,trial_used,updated) VALUES(?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET expires=excluded.expires,trial_used=excluded.trial_used,updated=excluded.updated').run(userId,expires,old?.trial_used||0,now());db.prepare('INSERT INTO subscription_events(user_id,source,plan,days,expires,created) VALUES(?,?,?,?,?,?)').run(userId,source,planId,days,expires,now());return member(userId);}
 function transaction(action){db.exec('BEGIN IMMEDIATE');try{const value=action();db.exec('COMMIT');return value;}catch(error){db.exec('ROLLBACK');throw error;}}
 const releaseDir=path.join(DATA,'releases');await mkdir(releaseDir,{recursive:true});
 const streams=new Map();const chatRates=new Map();
 const chatSelect="SELECT m.id,m.user_id,m.body,m.created,u.username,(SELECT '/avatars/'||u.id||'?v='||avatar_version FROM user_profiles WHERE user_id=u.id) AS avatarUrl,(SELECT role FROM user_roles WHERE user_id=u.id) AS role,(SELECT expires FROM memberships WHERE user_id=u.id) AS subscriptionExpires FROM chat_messages m JOIN users u ON u.id=m.user_id ";
 function presence(){return {online:new Set([...streams.values()].map(x=>x.userId)).size};}
 function event(res,type,value,id){res.write((id?'id: '+id+'\n':'')+'event: '+type+'\ndata: '+JSON.stringify(value)+'\n\n');}
 function broadcast(type,value,id){for(const res of streams.keys())if(!res.destroyed&&!res.writableEnded)event(res,type,value,id);}
 function closeSession(token){for(const [res,s] of streams)if(s.token===token)res.end();}
 async function download(req,res,url,session){
  if(!['GET','HEAD'].includes(req.method))throw errors(405,'不支持此请求方式。');
  const id=url.pathname.match(/^\/downloads\/(\d+)$/)?.[1];const release=id?db.prepare('SELECT * FROM releases WHERE id=?').get(id):null;if(!release)throw errors(404,'找不到此资源。');
  const user=requireUser(session);if(release.members_only&&!member(user).active)throw errors(403,'请先激活订阅，再下载会员资源。');
  const file=path.join(releaseDir,release.disk_name);if(path.dirname(path.resolve(file))!==path.resolve(releaseDir))throw errors(404,'文件不存在。');
  try{await stat(file);}catch{throw errors(404,'此文件暂不可用，请联系管理员重新上传。');}
  res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':release.size,'Content-Disposition':'attachment; filename="'+release.filename.replace(/[^a-zA-Z0-9_.-]/g,'_')+'"; filename*=UTF-8\'\''+encodeURIComponent(release.filename),'Cache-Control':'private, no-store','X-Content-SHA256':release.sha256});
  if(req.method==='HEAD'){res.end();return;}
  const stream=createReadStream(file);stream.on('error',()=>res.destroy());stream.on('end',()=>db.prepare('INSERT INTO download_events(release_id,user_id,created) VALUES(?,?,?)').run(release.id,session?.user_id||null,now()));res.on('close',()=>stream.destroy());stream.pipe(res);
 }
 async function handle(req,res,url,session){
  const route=url.pathname,method=req.method;
  if(method==='GET'&&route==='/api/subscription'){const id=requireUser(session);send(res,200,{plans,membership:member(id),orders:id?db.prepare('SELECT * FROM subscription_orders WHERE user_id=? ORDER BY created DESC LIMIT 30').all(id):[],history:id?db.prepare("SELECT * FROM subscription_events WHERE user_id=? AND source<>'trial' ORDER BY id DESC LIMIT 30").all(id):[],billingMode:'manual'});return true;}
  if(method==='POST'&&route==='/api/subscription/orders'){const id=requireUser(session);const body=await jsonBody(req);const p=plan(body.plan);if(db.prepare("SELECT id FROM subscription_orders WHERE user_id=? AND status='pending'").get(id))throw errors(409,'已有一条待审核的订阅申请。');const orderId='GS-'+now().toString(36).toUpperCase()+'-'+randomBytes(3).toString('hex').toUpperCase();db.prepare('INSERT INTO subscription_orders(id,user_id,plan,status,created) VALUES(?,?,?,\'pending\',?)').run(orderId,id,p.id,now());send(res,201,{order:db.prepare('SELECT * FROM subscription_orders WHERE id=?').get(orderId)});return true;}
  const cancel=route.match(/^\/api\/subscription\/orders\/([A-Z0-9-]+)\/cancel$/);
  if(method==='POST'&&cancel){const id=requireUser(session);const order=db.prepare('SELECT * FROM subscription_orders WHERE id=? AND user_id=?').get(cancel[1],id);if(!order)throw errors(404,'申请不存在。');if(order.status!=='pending')throw errors(409,'只能取消待审核的申请。');db.prepare("UPDATE subscription_orders SET status='cancelled' WHERE id=?").run(order.id);send(res,200,{ok:true});return true;}
  if(method==='POST'&&route==='/api/subscription/redeem'){const id=requireUser(session);const body=await jsonBody(req);const code=text(body.code,8,80,'激活码').toUpperCase();const result=transaction(()=>{const record=db.prepare('SELECT * FROM subscription_codes WHERE hash=?').get(hashToken(code));if(!record||record.redeemed_by)throw errors(400,'激活码无效或已被使用。');const p=plan(record.plan,true);db.prepare('UPDATE subscription_codes SET redeemed_by=?,redeemed=? WHERE id=?').run(id,now(),record.id);return extend(id,p.days,'code',p.id);});send(res,200,{membership:result,user:publicUser(id)});return true;}
  if(method==='GET'&&route==='/api/releases'){requireUser(session);const releases=db.prepare('SELECT id,title,version,filename,size,sha256,notes,members_only,created,(SELECT count(*) FROM download_events WHERE release_id=releases.id) AS downloads FROM releases ORDER BY id DESC').all();send(res,200,{releases,membership:member(session?.user_id)});return true;}
  if(method==='GET'&&route==='/api/admin/overview'){requireAdmin(session);send(res,200,{plans,orders:db.prepare('SELECT o.*,u.username FROM subscription_orders o JOIN users u ON u.id=o.user_id ORDER BY o.created DESC LIMIT 100').all(),codes:db.prepare('SELECT c.id,c.tail,c.plan,c.created,c.redeemed,u.username AS redeemed_by FROM subscription_codes c LEFT JOIN users u ON u.id=c.redeemed_by ORDER BY c.id DESC LIMIT 50').all(),users:db.prepare("SELECT u.id,u.username,coalesce(r.role,'member') AS role,m.expires,u.disabled FROM users u LEFT JOIN user_roles r ON r.user_id=u.id LEFT JOIN memberships m ON m.user_id=u.id WHERE u.password<>'' ORDER BY u.id").all()});return true;}
  const userAction=route.match(/^\/api\/admin\/users\/(\d+)\/(disable|enable)$/);
  if(method==='POST'&&userAction){const adminId=requireAdmin(session);const targetId=Number(userAction[1]);const action=userAction[2];if(action==='disable'&&targetId===adminId)throw errors(400,'不能禁用自己的账号。');if(!db.prepare('SELECT id FROM users WHERE id=? AND password<>\'\'').get(targetId))throw errors(404,'用户不存在。');if(action==='disable'){for(const active of db.prepare('SELECT token FROM sessions WHERE user_id=?').all(targetId))closeSession(active.token);db.prepare('DELETE FROM sessions WHERE user_id=?').run(targetId);}db.prepare('UPDATE users SET disabled=? WHERE id=?').run(action==='disable'?1:0,targetId);send(res,200,{ok:true,disabled:action==='disable'});return true;}
  const approve=route.match(/^\/api\/admin\/orders\/([A-Z0-9-]+)\/approve$/);
  if(method==='POST'&&approve){requireAdmin(session);const result=transaction(()=>{const order=db.prepare('SELECT * FROM subscription_orders WHERE id=?').get(approve[1]);if(!order)throw errors(404,'申请不存在。');if(order.status==='active')return member(order.user_id);if(order.status!=='pending')throw errors(409,'此申请已取消。');const p=plan(order.plan,true);const membership=extend(order.user_id,p.days,'administrator',p.id);db.prepare("UPDATE subscription_orders SET status='active',activated=? WHERE id=?").run(now(),order.id);return membership;});send(res,200,{membership:result});return true;}
  if(method==='POST'&&route==='/api/admin/codes'){const id=requireAdmin(session);const body=await jsonBody(req);const p=plan(body.plan);const code='GS-'+randomBytes(12).toString('hex').toUpperCase().match(/.{1,4}/g).join('-');db.prepare('INSERT INTO subscription_codes(hash,tail,plan,created_by,created) VALUES(?,?,?,?,?)').run(hashToken(code),code.slice(-4),p.id,id,now());send(res,201,{code,plan:p.id,days:p.days});return true;}
  if(method==='POST'&&route==='/api/admin/releases'){
   requireAdmin(session);const title=text(url.searchParams.get('title'),3,100,'标题');const version=text(url.searchParams.get('version'),1,40,'版本');const filename=text(url.searchParams.get('filename'),1,160,'文件名');if(/[\x00-\x1f\\/]/.test(filename))throw errors(400,'文件名不能包含文件夹路径。');const notes=text(url.searchParams.get('notes')||'No release notes.',1,5000,'更新说明');const membersOnly=url.searchParams.get('access')!=='public';
   const diskName=randomBytes(20).toString('hex')+'.bin';const file=path.join(releaseDir,diskName);
   let size=0;const digest=createHash('sha256');let handle;let id;
   try {
    handle=await open(file,'wx');
    // Await each disk write to apply backpressure without buffering the entire upload.
    for await(const chunk of req){await handle.writeFile(chunk);size+=chunk.length;digest.update(chunk);}
    if(!size)throw errors(400,'请选择非空文件。');
    await handle.close();handle=null;
    id=Number(db.prepare('INSERT INTO releases(title,version,filename,disk_name,size,sha256,notes,members_only,created) VALUES(?,?,?,?,?,?,?,?,?)').run(title,version,filename,diskName,size,digest.digest('hex'),notes,membersOnly?1:0,now()).lastInsertRowid);
   }catch(error){
    if(handle)await handle.close().catch(()=>{});
    await unlink(file).catch(cleanupError=>{if(cleanupError.code!=='ENOENT')console.error('Upload cleanup failed:',cleanupError);});
    throw error;
   }
   send(res,201,{id,size});return true;
  }
  if(method==='GET'&&route==='/api/chat/messages'){requireUser(session);const before=Number(url.searchParams.get('before'));const rows=before>0?db.prepare(chatSelect+'WHERE m.id<? ORDER BY m.id DESC LIMIT 50').all(before):db.prepare(chatSelect+'ORDER BY m.id DESC LIMIT 50').all();const messages=rows.reverse();const first=messages[0]?.id||0;send(res,200,{messages,hasMore:Boolean(first&&db.prepare('SELECT 1 FROM chat_messages WHERE id<? LIMIT 1').get(first)),...presence()});return true;}
  if(method==='POST'&&route==='/api/chat/messages'){const id=requireUser(session);const body=await jsonBody(req);const message=text(body.body,1,1000,'内容');const bucket=chatRates.get(id);if(bucket&&now()-bucket.time<10000&&bucket.count>=10)throw errors(429,'发送过于频繁，请稍等几秒后再试。');chatRates.set(id,bucket&&now()-bucket.time<10000?{time:bucket.time,count:bucket.count+1}:{time:now(),count:1});const result=db.prepare('INSERT INTO chat_messages(user_id,body,created) VALUES(?,?,?)').run(id,message,now());const record=db.prepare(chatSelect+'WHERE m.id=?').get(Number(result.lastInsertRowid));broadcast('message',record,record.id);send(res,201,{message:record});return true;}
  if(method==='GET'&&route==='/api/chat/stream'){
   const id=requireUser(session);const raw=req.headers['last-event-id']||url.searchParams.get('after')||'0';const after=/^\d+$/.test(raw)?Number(raw):0;res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no'});res.flushHeaders();streams.set(res,{userId:id,token:session.token});
   const rows=db.prepare(chatSelect+'WHERE m.id>? ORDER BY m.id DESC LIMIT 100').all(after).reverse();for(const message of rows)event(res,'message',message,message.id);broadcast('presence',presence());
   const interval=setInterval(()=>{const active=currentSession(req);if(!active||active.user_id!==id){event(res,'expired',{error:'Your session expired.'});res.end();}else res.write(': keepalive\n\n');},15000);res.on('close',()=>{clearInterval(interval);streams.delete(res);broadcast('presence',presence());});return true;
  }
  return false;
 }
 return {handle,download,ensureOwner,closeSession,shutdown(){for(const res of streams.keys())res.end();},member};
}
