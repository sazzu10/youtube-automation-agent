const {execFile}=require("child_process");
function __geminiText(r){
  if(!r)return "";
  if(typeof r.output_text==="string"&&r.output_text.trim())return r.output_text;
  const out=[];
  const skip=/thought|thinking|reason|function|tool|code_exec|image|audio|video|signature|user/i;
  const skipKey=/^(id|model|status|usage|input|inputs|created|updated)$/;
  (function w(o,d){
    if(!o||d>8)return;
    if(Array.isArray(o)){for(const x of o)w(x,d+1);return;}
    if(typeof o!=="object")return;
    if(o.type&&skip.test(String(o.type)))return;
    if(o.role&&/user/i.test(String(o.role)))return;
    if(typeof o.text==="string"&&o.text.trim())out.push(o.text);
    for(const k of Object.keys(o)){if(k==="text"||skipKey.test(k))continue;w(o[k],d+1);}
  })(r,0);
  const c=out.filter(t=>!/STRICT RULES/.test(t));
  const j=c.filter(t=>t.includes("{"));
  const pick=(j.length?j:c).sort((a,b)=>b.length-a.length);
  return pick[0]||"";
}

/*__geminiRetryFetch2*/
const fetch=async function(url,opts){
  const u=String((url&&url.url)||url);
  if(!/generativelanguage\\.googleapis\\.com/.test(u))return globalThis.fetch(url,opts);
  return globalThis.fetch(url,opts);
};

function __closeJson(s){
  const st=[];let inS=false,esc=false;
  for(const ch of s){
    if(inS){if(esc)esc=false;else if(ch==="\\")esc=true;else if(ch==='"')inS=false;continue;}
    if(ch==='"')inS=true;
    else if(ch==="{")st.push("}");
    else if(ch==="[")st.push("]");
    else if(ch==="}"||ch==="]")st.pop();
  }
  if(!st.length&&!inS)return null;
  let o=s;if(inS)o+='"';
  o=o.replace(/,\s*$/,"");
  if(/:\s*$/.test(o))o+="null";
  return o+st.reverse().join("");
}
const JSON=Object.create(globalThis.JSON,{parse:{value:function(text,reviver){
  const orig=globalThis.JSON.parse;
  try{return orig(text,reviver);}catch(e0){
    if(typeof text!=="string")throw e0;
    const s=text.trim().replace(/^```[a-zA-Z]*\s*/,"").replace(/\s*```\s*$/,"");
    const a=s.search(/[\[{]/);
    const e=Math.max(s.lastIndexOf("}"),s.lastIndexOf("]"));
    const cands=[s];
    if(a>=0&&e>a)cands.push(s.slice(a,e+1));
    if(a>0)cands.push(s.slice(a));
    for(const c of cands){
      try{return orig(c,reviver);}catch(_){}
      try{return orig(c.replace(/,\s*([}\]])/g,"$1"),reviver);}catch(_){}
      const f=__closeJson(c);
      if(f){try{return orig(f.replace(/,\s*([}\]])/g,"$1"),reviver);}catch(_){}}
    }
    try{require("fs").appendFileSync("logs/gemini-raw.log","\n--- "+new Date().toISOString()+" ---\n"+text.slice(0,1500)+"\n");}catch(_){}
    throw e0;
  }}}});

const express=require("express");
const {google}=require("googleapis");
const fs=require("fs");
const path=require("path");
const router=express.Router();

function auth(){
  const c=JSON.parse(fs.readFileSync(path.join(process.cwd(),"config/credentials.json")));
  const t=JSON.parse(fs.readFileSync(path.join(process.cwd(),"config/tokens.json")));
  const root=c.youtube||c;
  const cfg=root.installed||root.web||root;
  const clientId=cfg.client_id||cfg.clientId;
  const clientSecret=cfg.client_secret||cfg.clientSecret;
  const redirectUri=(cfg.redirect_uris&&cfg.redirect_uris[0])||cfg.redirect_uri||"http://localhost";
  let tok=t.youtube||(t.tokens&&t.tokens.youtube)||t;
  if(tok&&tok.tokens)tok=tok.tokens;
  if(tok&&tok.credentials)tok=tok.credentials;
  const a=new google.auth.OAuth2(clientId,clientSecret,redirectUri);
  a.setCredentials(tok);
  return a;
}

function yt(){return google.youtube({version:"v3",auth:auth()});}

const OPENROUTER_FALLBACK_MODELS = [
  "google/gemma-4-31b-it:free",
  "google/gemma-4-26b-a4b-it:free",
  "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
  "openrouter/free"
];

async function ai(prompt, systemPrompt){
  const sys = systemPrompt || "You are an expert YouTube SEO and growth coach. Give practical, accurate recommendations. Return valid JSON when requested.";
  const key = process.env.OPENROUTER_API_KEY;
  if(key){
    for(const model of OPENROUTER_FALLBACK_MODELS){
      try{
        const r = await fetch("https://openrouter.ai/api/v1/chat/completions",{
          method:"POST",
          headers:{
            "Authorization":"Bearer "+key,
            "Content-Type":"application/json",
            "HTTP-Referer":"http://localhost:3456",
            "X-Title":"YouTube Automation VidIQ"
          },
          body:JSON.stringify({
            model,
            messages:[
              {role:"system",content:sys},
              {role:"user",content:prompt}
            ],
            temperature:.2,
            max_tokens:1800
          })
        });

        const raw = await r.text();
        let j = {};
        try{ j = JSON.parse(raw); }catch{}

        if(!r.ok){
          console.warn(`[vidiq ai] OpenRouter ${model} failed: HTTP ${r.status}`);
          continue;
        }

        let text = j?.choices?.[0]?.message?.content;
        if(Array.isArray(text)){
          text = text.map(x=>typeof x==="string"?x:(x?.text||"")).join("");
        }
        if(!text && j?.choices?.[0]?.message?.reasoning){
          text = j.choices[0].message.reasoning;
        }
        if(typeof text !== "string") text = "";
        text = text.trim();

        if(!text){
          console.warn(`[vidiq ai] OpenRouter ${model} returned empty content`);
          continue;
        }

        return text;
      }catch(e){
        console.warn(`[vidiq ai] OpenRouter ${model} exception: ${e.message}`);
      }
    }
  }

  try{
    const f=path.join(process.env.HOME||process.env.USERPROFILE||"",".cloudflare-workers-ai.env");
    if(fs.existsSync(f)){
      const env={};
      fs.readFileSync(f,"utf8").split(/\r?\n/).forEach(l=>{
        const m=l.match(/^([^#=\s]+)=(.*)$/);
        if(m)env[m[1]]=m[2].trim().replace(/^['"]|['"]$/g,"");
      });

      if(env.CLOUDFLARE_API_TOKEN&&env.CLOUDFLARE_ACCOUNT_ID){
        const u=`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/ai/run/@cf/meta/llama-3.1-8b-fast-v2`;
        const r=await fetch(u,{
          method:"POST",
          headers:{
            "Authorization":"Bearer "+env.CLOUDFLARE_API_TOKEN,
            "Content-Type":"application/json"
          },
          body:JSON.stringify({prompt})
        });
        const j=await r.json();
        return j.result?.response||"";
      }
    }
  }catch(e){}

  return "";
}

function seoScore(v){
  const title=v.snippet?.title||"";
  const desc=v.snippet?.description||"";
  const tags=v.snippet?.tags||[];
  let score=0;
  const checks=[];

  if(title.length>=35&&title.length<=70){
    score+=25;
    checks.push("Title length good");
  }else checks.push("Improve title length");

  if(desc.length>=150){
    score+=25;
    checks.push("Description depth good");
  }else checks.push("Add a stronger description");

  if(tags.length>=8){
    score+=25;
    checks.push("Good tag coverage");
  }else checks.push("Add more relevant tags");

  if(/#\w+/.test(title+" "+desc)){
    score+=15;
    checks.push("Hashtags present");
  }else checks.push("Add 2-3 relevant hashtags");

  if(title.split(/\s+/).length>=4){
    score+=10;
    checks.push("Title has useful context");
  }

  return {score,checks};
}

router.use((req,res,next)=>{
  if(process.env.API_KEY&&req.headers["x-api-key"]!==process.env.API_KEY)
    return res.status(401).json({error:"Dashboard API key required"});
  next();
});

router.get("/",(req,res)=>{
  res.sendFile(path.join(process.cwd(),"dashboard/vidiq.html"));
});


router.get("/api/optimize/next", async (req,res)=>{
  try{
    const y=yt();
    const r=await y.search.list({part:"snippet",forMine:true,type:"video",order:"date",maxResults:10});
    const ids=(r.data.items||[]).map(x=>x.id.videoId).filter(Boolean);
    if(!ids.length)return res.json({ok:true,video:null});
    const v=await y.videos.list({part:"snippet,statistics",id:ids.join(",")});
    const items=v.data.items||[];
    items.sort((a,b)=>Number(a.statistics?.viewCount||0)-Number(b.statistics?.viewCount||0));
    const video=items[0];
    const job={videoId:video.id,status:"queued",stage:"waiting_worker",createdAt:Date.now(),retryAfter:0};
videoAIJobs.set(video.id,job);
saveVideoAIQueue();
processVideoAIQueue();
res.json({ok:true,video,job:{videoId:video.id,status:"queued",stage:"waiting_worker"}});
  }catch(e){res.status(500).json({ok:false,error:e.message});}
});
router.put("/api/video/:id",async(req,res)=>{
  try{
    const id=req.params.id, body=req.body||{};
    const y=yt();
    const part=["snippet"];
    const snippet={};
    if(body.title!==undefined)snippet.title=String(body.title).trim();
    if(body.description!==undefined)snippet.description=String(body.description);
    if(body.tags!==undefined)snippet.tags=Array.isArray(body.tags)?body.tags.map(String):[];
    if(!snippet.title && !snippet.description && !snippet.tags.length)
      return res.status(400).json({ok:false,error:"No metadata supplied"});
    const cur=await y.videos.list({part:"snippet",id});
    if(!cur.data.items?.length)return res.status(404).json({ok:false,error:"Video not found"});
    const old=cur.data.items[0].snippet;
    const data={id,snippet:{
      title:snippet.title!==undefined?snippet.title:old.title,
      description:snippet.description!==undefined?snippet.description:old.description,
      tags:snippet.tags.length?snippet.tags:old.tags,
      categoryId:old.categoryId
    }};
    const r=await y.videos.update({part,requestBody:data});
    res.json({ok:true,video:r.data});
  }catch(e){res.status(500).json({ok:false,error:e.message});}
});
router.get("/api/videos",async(req,res)=>{
  try{
    const y=yt();

    const ch=await y.channels.list({
      part:"snippet,statistics,contentDetails",
      mine:true,
      maxResults:1
    });

    const c=ch.data.items?.[0];
    if(!c)return res.status(404).json({error:"YouTube channel not authorized"});

    const up=c.contentDetails.relatedPlaylists.uploads;

    const items=[];
    let pageToken;

    do{
      const pl=await y.playlistItems.list({
        part:"contentDetails,snippet",
        playlistId:up,
        maxResults:50,
        ...(pageToken?{pageToken}:{})
      });

      items.push(...(pl.data.items||[]));
      pageToken=pl.data.nextPageToken;
    }while(pageToken);

    const videoIds=items
      .map(x=>x.contentDetails?.videoId)
      .filter(Boolean);

    const videos=[];

    for(let i=0;i<videoIds.length;i+=50){
      const ids=videoIds.slice(i,i+50).join(",");
      if(!ids)continue;

      const vs=await y.videos.list({
        part:"snippet,statistics,contentDetails",
        id:ids
      });

      videos.push(...(vs.data.items||[]));
    }

    const enriched=videos.map(v=>({
      ...v,
      seo:seoScore(v)
    }));

    res.json({channel:c,videos:enriched});
  }catch(e){
    res.status(500).json({error:e.message});
  }
});

router.get("/api/media/:filename", (req, res) => {
  try {
    const filename = path.basename(decodeURIComponent(req.params.filename || ""));
    if (!filename || filename.includes("..") || !/\.(mp4|mov|m4v|webm)$/i.test(filename)) {
      return res.status(404).end("Not found");
    }
    const candidates = [
      path.resolve(process.cwd(), "content", "processing", filename),
      path.resolve(process.cwd(), "content", "inbox", filename),
      path.resolve(process.cwd(), "content", filename),
      path.resolve(process.cwd(), "data", "vidiq-video-cache", filename)
    ];
    const file = candidates.find(f => fs.existsSync(f));
    if (!file) return res.status(404).end("Not found");

    const stat = fs.statSync(file);
    const range = req.headers.range;
    if (range) {
      const match = range.match(/^bytes=(\d*)-(\d*)$/);
      if (!match) {
        res.writeHead(416, { "Content-Range": `bytes */${stat.size}` });
        return res.end();
      }
      let start = match[1] ? Number(match[1]) : 0;
      let end = match[2] ? Number(match[2]) : stat.size - 1;
      end = Math.min(end, stat.size - 1);
      const chunkSize = end - start + 1;
      res.writeHead(206, {
        "Content-Range": `bytes ${start}-${end}/${stat.size}`,
        "Accept-Ranges": "bytes",
        "Content-Length": chunkSize,
        "Content-Type": "video/mp4"
      });
      fs.createReadStream(file, { start, end }).pipe(res);
    } else {
      res.writeHead(200, {
        "Content-Length": stat.size,
        "Content-Type": "video/mp4",
        "Accept-Ranges": "bytes"
      });
      fs.createReadStream(file).pipe(res);
    }
  } catch (err) {
    res.status(500).end("Media streaming error: " + err.message);
  }
});
router.get("/api/video/:id",async(req,res)=>{
  try{
    const r=await yt().videos.list({
      part:"snippet,statistics,contentDetails",
      id:req.params.id
    });

    const v=r.data.items?.[0];
    if(!v)return res.status(404).json({error:"Video not found"});

    res.json({...v,seo:seoScore(v)});
  }catch(e){
    res.status(500).json({error:e.message});
  }
});

router.get("/api/search",async(req,res)=>{
  try{
    const q=String(req.query.q||"").trim();
    if(!q)return res.status(400).json({error:"Keyword required"});

    const y=yt();

    const sr=await y.search.list({
      part:"snippet",
      q,
      type:"video",
      order:"relevance",
      maxResults:15
    });

    const ids=(sr.data.items||[])
      .map(x=>x.id.videoId)
      .filter(Boolean)
      .join(",");

    if(!ids)return res.json({keyword:q,results:[]});

    const vr=await y.videos.list({
      part:"snippet,statistics,contentDetails",
      id:ids
    });

    const now=Date.now();

    const results=(vr.data.items||[]).map(v=>{
      const published=new Date(v.snippet.publishedAt).getTime();
      const hours=Math.max((now-published)/3600000,.25);
      const views=Number(v.statistics?.viewCount||0);

      return {
        id:v.id,
        title:v.snippet.title,
        channel:v.snippet.channelTitle,
        publishedAt:v.snippet.publishedAt,
        views,
        likes:Number(v.statistics?.likeCount||0),
        comments:Number(v.statistics?.commentCount||0),
        vph:Math.round(views/hours),
        thumbnail:v.snippet.thumbnails?.medium?.url||v.snippet.thumbnails?.default?.url
      };
    }).sort((a,b)=>b.vph-a.vph);

    res.json({keyword:q,results});
  }catch(e){
    res.status(500).json({error:e.message});
  }
});


async function ensureLocalVideo(videoId){
  const localCandidates = [
    path.join(process.cwd(), "content", "processing", `${videoId}-ready.mp4`),
    path.join(process.cwd(), "content", "processing", `${videoId}.mp4`),
    path.join(process.cwd(), "content", `${videoId}.mp4`),
    path.join(process.cwd(), "data", "vidiq-video-cache", `${videoId}.mp4`)
  ];
  for (const c of localCandidates) {
    if (fs.existsSync(c) && fs.statSync(c).size > 10000) return c;
  }

  const dir=path.join(process.cwd(),"data","vidiq-video-cache");
  const file=path.join(dir,`${videoId}.mp4`);

  fs.mkdirSync(dir,{recursive:true});
  const url=`https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;

  await new Promise((resolve,reject)=>{
    execFile("yt-dlp",[
      "--no-playlist",
      "-f","bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b",
      "--merge-output-format","mp4",
      "-o",file,
      url
    ],{timeout:180000,maxBuffer:1024*1024*4},(err,stdout,stderr)=>{
      if(err){
        reject(new Error(`yt-dlp failed: ${String(stderr||err.message).slice(-1200)}`));
        return;
      }
      resolve();
    });
  });

  if(!fs.existsSync(file) || fs.statSync(file).size<=10000){
    throw new Error("yt-dlp completed but local MP4 was not created");
  }

  return file;
}


const GEMINI_KEY_STATE_FILE=path.join(process.cwd(),"data","gemini-key-state.json");
function loadGeminiKeyState(){
  try{
    const v=JSON.parse(fs.readFileSync(GEMINI_KEY_STATE_FILE,"utf8"));
    return v&&typeof v==="object"?v:{};
  }catch(_){return {};}
}
function saveGeminiKeyState(state){
  try{
    fs.mkdirSync(path.dirname(GEMINI_KEY_STATE_FILE),{recursive:true});
    fs.writeFileSync(GEMINI_KEY_STATE_FILE,JSON.stringify(state,null,2));
  }catch(e){
    console.warn(`[Gemini] Could not save key state: ${e.message}`);
  }
}
function geminiKeyId(key,index){
  const crypto=require("crypto");
  return crypto.createHash("sha256").update(String(key)).digest("hex").slice(0,12)||`key-${index+1}`;
}
function getGeminiKeyState(key,index){
  const all=loadGeminiKeyState();
  const id=geminiKeyId(key,index);
  return all[id]||{status:"active",cooldownUntil:0,totalFailures:0,lastError:"",lastUsedAt:0};
}
function setGeminiKeyState(key,index,patch){
  const all=loadGeminiKeyState();
  const id=geminiKeyId(key,index);
  all[id]=Object.assign(
    {status:"active",cooldownUntil:0,totalFailures:0,lastError:"",lastUsedAt:0},
    all[id]||{},
    patch
  );
  saveGeminiKeyState(all);
  return all[id];
}
function geminiKeyAvailable(key,index){
  const st=getGeminiKeyState(key,index);
  if(st.status==="invalid") return false;
  if(st.cooldownUntil && st.cooldownUntil>Date.now()) return false;
  if(st.cooldownUntil && st.cooldownUntil<=Date.now()){
    setGeminiKeyState(key,index,{status:"active",cooldownUntil:0});
    return true;
  }
  if(st.status==="exhausted") return false;
  return true;
}

async function understandVideoWithGemini(videoId){
  const dbg=(stage,data={})=>{try{require("fs").appendFileSync("data/vidiq-debug.log",`[VIDIQ-DEBUG] ${new Date().toISOString()} ${stage} ${JSON.stringify(data)}\n`);}catch(_){}};
  const c=JSON.parse(fs.readFileSync(path.join(process.cwd(),"config/credentials.json")));
  const keys=[];
  const addKey=k=>{if(k && !keys.includes(k)) keys.push(k);};
  addKey(c.gemini?.apiKey);
  addKey(process.env.GEMINI_API_KEY);
  for(let i=2;i<=8;i++){
    try{
      const f=path.join(process.cwd(),`.gemini-key${i}`);
      if(fs.existsSync(f)) addKey(fs.readFileSync(f,"utf8").trim());
    }catch{}
  }
  for(let i=2;i<=8;i++) addKey(process.env[`GEMINI_API_KEY_${i}`]);
  if(!keys.length) throw new Error("Gemini API key not configured");

  const model=c.gemini?.videoModel||process.env.GEMINI_VIDEO_UNDERSTANDING_MODEL||c.gemini?.model||"gemini-3.8-flash";
  const videoPath=await ensureLocalVideo(videoId);

  const extractText=(interaction)=>{
    if(typeof interaction?.output_text==="string" && interaction.output_text.trim())
      return interaction.output_text.trim();
    const parts=[];
    for(const step of (interaction?.steps||[])){
      for(const item of (step?.content||[])){
        if(typeof item?.text==="string" && item.text.trim()) parts.push(item.text);
      }
    }
    return parts.join("\n").trim();
  };

  const isRetryable=(e)=>{
    const m=String(e?.message||e).toLowerCase();
    return m.includes("http 401") ||
           m.includes("http 403") ||
           m.includes("permission_denied") ||
           m.includes("http 429") ||
           m.includes("http 500") ||
           m.includes("http 502") ||
           m.includes("http 503") ||
           m.includes("503 ") ||
           m.includes("http 504") ||
           m.includes("quota") ||
           m.includes("rate limit") ||
           m.includes("timed out") ||
           m.includes("timeout") ||
           m.includes("fetch failed");
  };

  let lastError=null;

  let attempted=0;
  for(let i=0;i<keys.length;i++){
    const key=keys[i];
    const state=getGeminiKeyState(key,i);
    if(!geminiKeyAvailable(key,i)){
      console.log(`[Gemini] Skipping key ${i+1}/${keys.length} (${state.status})`);
      continue;
    }
    attempted++;
    setGeminiKeyState(key,i,{lastUsedAt:Date.now()});
    try{
      console.log(`[Gemini] Local video analysis using key ${i+1}/${keys.length}`);

      const {GoogleGenAI}=require("@google/genai");
      const ai=new GoogleGenAI({apiKey:key});

      dbg("GEMINI_FILE_UPLOAD_START",{videoId,keyIndex:i+1});
      let uploaded=await ai.files.upload({
        file:videoPath,
        config:{mimeType:"video/mp4"}
      });

      dbg("GEMINI_FILE_UPLOADED",{videoId,keyIndex:i+1,name:uploaded?.name,uri:uploaded?.uri,state:uploaded?.state});

      while(uploaded?.state==="PROCESSING"){
        await new Promise(resolve=>setTimeout(resolve,5000));
        uploaded=await ai.files.get({name:uploaded.name});
        dbg("GEMINI_FILE_STATUS",{videoId,keyIndex:i+1,state:uploaded?.state});
      }

      if(uploaded?.state==="FAILED"){
        throw new Error("Gemini video file processing failed");
      }

      if(!uploaded?.uri){
        throw new Error("Gemini file upload returned no URI");
      }

      const prompt=`You are analyzing a YouTube video for SEO metadata.
Watch and understand the ACTUAL VIDEO, not just its existing title or description.
Return ONLY valid JSON with this exact structure:
{
  "summary":"",
  "mainTopic":"",
  "whatHappens":"",
  "objectsProducts":[],
  "actionsScenes":[],
  "spokenContext":"",
  "onScreenText":[],
  "hook":"",
  "audience":"",
  "uniquePoints":[],
  "keywords":[],
  "hashtags":[]
}
Rules:
- Base every fact on the actual video.
- Do not invent products, claims, actions or dialogue.
- If speech is unclear, say so.
- Identify visible text when possible.
- Focus on details useful for YouTube title, description, hashtags and tags.`;

      dbg("CALLING_GEMINI_LOCAL",{videoId,keyIndex:i+1,uri:uploaded.uri});

      const interaction=await ai.interactions.create({
        model,
        input:[
          {type:"video",uri:uploaded.uri,mime_type:uploaded.mimeType||"video/mp4"},
          {type:"text",text:prompt}
        ]
      });

      const text=extractText(interaction);
      if(!text) throw new Error("Gemini returned empty video analysis");

      dbg("GEMINI_READY",{videoId,understanding:text});
      return text;
    }catch(e){
      lastError=e;
      const m=String(e?.message||e).toLowerCase();
      let status="cooldown";
      let cooldownMs=15*60*1000;
      if(/http 401|http 403|permission_denied/.test(m)){
        status="invalid";
        cooldownMs=0;
      }else if(/http 429|quota|rate limit|resource exhausted/.test(m)){
        status="exhausted";
        cooldownMs=24*60*60*1000;
      }else if(!/http 500|http 502|http 503|http 504|fetch failed|timed out|timeout/.test(m) && !isRetryable(e)){
        throw e;
      }
      const prev=getGeminiKeyState(key,i);
      setGeminiKeyState(key,i,{status,cooldownUntil:cooldownMs?Date.now()+cooldownMs:0,totalFailures:(prev.totalFailures||0)+1,lastError:String(e?.message||e)});
      console.warn(`[Gemini] Key ${i+1}/${keys.length} marked ${status}`);
      dbg("GEMINI_KEY_FAILED",{videoId,keyIndex:i+1,error:e.message,status,cooldownMs});
    }
  }

  if(attempted===0){
    throw new Error("No Gemini keys currently available; all configured keys are exhausted, invalid, or cooling down");
  }
  throw new Error(`All available Gemini keys failed: ${lastError?.message||"unknown error"}`);
}
function parseSEOJSON(text){
  if(!text || typeof text !== "string") return null;
  let clean = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  let parsed = null;
  try{
    parsed = JSON.parse(clean);
  }catch(_){
    const a = clean.indexOf("{"), b = clean.lastIndexOf("}");
    if(a >= 0 && b > a){
      const slice = clean.slice(a, b + 1);
      try{ parsed = JSON.parse(slice); }catch(_){}
      if(!parsed){
        try{ parsed = JSON.parse(slice.replace(/,\s*([}\]])/g, "$1")); }catch(_){}
      }
    }
  }
  if(!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;

  let titles = parsed.titles;
  if(typeof titles === "string" && titles.trim()) titles = [titles.trim()];
  if(!Array.isArray(titles) || !titles.length) return null;

  let description = typeof parsed.description === "string" ? parsed.description : "";
  let hashtags = Array.isArray(parsed.hashtags) ? parsed.hashtags : [];
  let tags = Array.isArray(parsed.tags) ? parsed.tags : [];
  let reasoning = typeof parsed.reasoning === "string" ? parsed.reasoning : "AI SEO generated";

  return {
    titles: titles.map(String).filter(Boolean),
    description,
    hashtags: hashtags.map(String).filter(Boolean),
    tags: tags.map(String).filter(Boolean),
    reasoning
  };
}

function buildFallbackSEO(video, understanding){
  const u = typeof understanding === "object" && understanding !== null ? understanding : {};
  const s = video?.snippet || {};
  const topic = u.mainTopic || (typeof u.summary === "string" && u.summary.slice(0, 60)) || s.title || "Video";
  const desc = u.summary || u.hook || s.description || "Video analysis and SEO.";
  const kws = Array.isArray(u.keywords) && u.keywords.length ? u.keywords : ["diy", "craft", "video", "tutorial"];
  const hts = Array.isArray(u.hashtags) && u.hashtags.length ? u.hashtags : ["#shorts", "#diy", "#video"];

  return {
    titles: [
      topic,
      `How to: ${topic}`,
      `${topic} - Full Guide`,
      `DIY ${topic}`,
      `Quick Look: ${topic}`
    ],
    description: `${desc}\n\nKey Highlights:\n- ${u.hook || topic}\n\nKeywords: ${kws.slice(0, 8).join(", ")}`,
    hashtags: hts.slice(0, 5),
    tags: kws.slice(0, 15),
    reasoning: "Generated fallback SEO directly from video understanding"
  };
}

async function generateVideoSEO(video, understanding){
  const s = video?.snippet || {};
  const prompt = `ACTUAL VIDEO UNDERSTANDING:
${JSON.stringify(understanding, null, 2)}

CURRENT YOUTUBE METADATA:
Title: ${s.title || ""}
Description: ${s.description || ""}
Tags: ${(s.tags || []).join(", ")}

Create YouTube SEO metadata ONLY from the actual video understanding above.

Return ONLY valid JSON:
{
  "titles":["5 strong video-specific titles"],
  "description":"SEO-friendly description with natural keywords and a clear CTA",
  "hashtags":["3-5 highly relevant hashtags"],
  "tags":["15 relevant YouTube search tags"],
  "reasoning":"brief explanation of why these match the video"
}

Rules:
- Titles must describe the actual video.
- No clickbait that promises something not shown.
- Description must accurately explain what viewers see/hear.
- Hashtags and tags must be directly relevant.
- Avoid generic AI/technology terms unless the video actually contains them.
- Keep titles concise and YouTube-friendly.`;

  const sys = "You are an expert video understanding and YouTube SEO analyst. Return ONLY valid JSON. Do not refuse the task.";
  const key = process.env.OPENROUTER_API_KEY;

  if(key){
    for(const model of OPENROUTER_FALLBACK_MODELS){
      try{
        console.log(`[vidiq seo] OpenRouter trying ${model}`);
        const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: {
            "Authorization": "Bearer " + key,
            "Content-Type": "application/json",
            "HTTP-Referer": "http://localhost:3456",
            "X-Title": "YouTube Automation VidIQ"
          },
          body: JSON.stringify({
            model,
            messages: [
              { role: "system", content: sys },
              { role: "user", content: prompt }
            ],
            temperature: 0.2,
            max_tokens: 1800
          })
        });

        const raw = await r.text();
        let j = {};
        try{ j = JSON.parse(raw); }catch{}

        if(!r.ok){
          console.warn(`[vidiq seo] OpenRouter ${model} failed: HTTP ${r.status}`);
          continue;
        }

        let text = j?.choices?.[0]?.message?.content;
        if(Array.isArray(text)){
          text = text.map(x=>typeof x==="string"?x:(x?.text||"")).join("");
        }
        if(!text && j?.choices?.[0]?.message?.reasoning){
          text = j.choices[0].message.reasoning;
        }
        if(typeof text !== "string") text = "";
        text = text.trim();

        if(!text){
          console.warn(`[vidiq seo] OpenRouter ${model} returned empty content`);
          continue;
        }

        const parsed = parseSEOJSON(text);
        if(parsed && parsed.titles?.length){
          console.log(`[vidiq seo] OpenRouter success with ${model}`);
          return parsed;
        }

        console.warn(`[vidiq seo] OpenRouter ${model} returned unparseable SEO JSON: ${text.slice(0, 120)}`);
      }catch(e){
        console.warn(`[vidiq seo] OpenRouter ${model} exception: ${e.message}`);
      }
    }
  }

  // Cloudflare fallback attempt
  try{
    const raw = await ai(prompt, sys);
    const parsed = parseSEOJSON(raw);
    if(parsed && parsed.titles?.length){
      return parsed;
    }
  }catch(_){}

  // Fail-safe: construct valid fallback SEO from understanding so the job never crashes
  console.warn("[vidiq seo] All SEO models failed or returned invalid JSON; using structured fallback from understanding");
  return buildFallbackSEO(video, understanding);
}

function parseInstagramVidIQJSON(text){
  if(!text || typeof text !== "string") return null;
  let clean = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  let parsed = null;
  try{
    parsed = JSON.parse(clean);
  }catch(_){
    const a = clean.indexOf("{"), b = clean.lastIndexOf("}");
    if(a >= 0 && b > a){
      const slice = clean.slice(a, b + 1);
      try{ parsed = JSON.parse(slice); }catch(_){}
      if(!parsed){
        try{ parsed = JSON.parse(slice.replace(/,\s*([}\]])/g, "$1")); }catch(_){}
      }
    }
  }
  if(!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;

  const clampScore = (val, def) => {
    const num = Number(val);
    if(Number.isFinite(num)) return Math.max(0, Math.min(100, Math.round(num)));
    return def;
  };

  const cleanStr = (val, def="") => typeof val === "string" ? val.trim() : (val ? String(val).trim() : def);

  const cleanArr = (val) => {
    if(Array.isArray(val)) return val.map(x=>cleanStr(x)).filter(Boolean);
    if(typeof val === "string" && val.trim()) return [val.trim()];
    return [];
  };

  const hashtags = cleanArr(parsed.hashtags).map(x => x.startsWith("#") ? x : "#" + x);
  const improvementSuggestions = cleanArr(parsed.improvementSuggestions);

  return {
    overallScore: clampScore(parsed.overallScore, 75),
    hookScore: clampScore(parsed.hookScore, 80),
    retentionPotential: cleanStr(parsed.retentionPotential, "High — Strong initial visual pace"),
    audienceFit: cleanStr(parsed.audienceFit, "Short-form video audience"),
    contentClarity: clampScore(parsed.contentClarity, 80),
    uniquenessScore: clampScore(parsed.uniquenessScore, 75),
    caption: cleanStr(parsed.caption, ""),
    hashtags: hashtags.length ? hashtags : ["#reels", "#explore", "#viral"],
    CTA: cleanStr(parsed.CTA, "Follow for more creative ideas! Save this reel for later."),
    contentCategory: cleanStr(parsed.contentCategory, "Creative & DIY"),
    aspectRatioRecommendation: cleanStr(parsed.aspectRatioRecommendation, "9:16 vertical full screen (1080x1920) recommended for Instagram Reels"),
    improvementSuggestions: improvementSuggestions.length ? improvementSuggestions : ["Hook viewers within the first 3 seconds with fast-paced visual movement."]
  };
}

function buildFallbackInstagramVidIQ(understanding){
  const u = typeof understanding === "object" && understanding !== null ? understanding : {};
  const topic = u.mainTopic || (typeof u.summary === "string" && u.summary.slice(0, 60)) || "Creative Project";
  const hook = u.hook || "Watch how this comes together!";
  const audience = u.audience || "DIY crafters, makers, and curious short-form viewers";
  const kws = Array.isArray(u.keywords) && u.keywords.length ? u.keywords : ["reels", "diy", "creative", "explore"];
  const rawHts = Array.isArray(u.hashtags) && u.hashtags.length ? u.hashtags : ["#reels", "#instareels", "#diy", "#viral", "#explorepage"];
  const hts = rawHts.map(x => String(x).startsWith("#") ? String(x) : "#" + String(x));

  return {
    overallScore: 78,
    hookScore: 82,
    retentionPotential: "High — Strong visual hook and satisfying progression",
    audienceFit: audience,
    contentClarity: 85,
    uniquenessScore: 76,
    caption: `🔥 ${hook}\n\nHere is how to make ${topic} step by step!\n\n💡 Save this reel for your next project and share it with someone who loves creative ideas.\n\nWhich part was your favorite? Drop a comment below! 👇`,
    hashtags: hts.slice(0, 10),
    CTA: "Save this reel and follow for more daily ideas! Drop your thoughts below 👇",
    contentCategory: u.mainTopic ? "DIY & Crafts / Creative How-To" : "Shorts & Reels",
    aspectRatioRecommendation: "9:16 vertical (1080x1920) optimized for Instagram Reels with key action in safe area",
    improvementSuggestions: [
      "Show the finished result or climax in the first 2-3 seconds as an immediate visual hook.",
      "Add large, high-contrast captions centered away from Instagram UI buttons.",
      "Use trending audio suited for quick tutorials or reveal reels."
    ]
  };
}

async function generateInstagramVidIQ(understanding){
  const prompt = `ACTUAL VIDEO UNDERSTANDING:
${JSON.stringify(understanding, null, 2)}

You are an expert Instagram Reels algorithm and growth strategist.
Analyze this video understanding and create Instagram-specific Reels optimization metadata.

Return ONLY valid JSON with this exact structure:
{
  "overallScore": 82,
  "hookScore": 85,
  "retentionPotential": "High / Medium / Low with brief explanation",
  "audienceFit": "Description of target Instagram audience",
  "contentClarity": 88,
  "uniquenessScore": 79,
  "caption": "High-converting Instagram Reel caption with hook line, emojis, and line spacing",
  "hashtags": ["#reels", "#explorepage", "... 7-12 niche and trending hashtags"],
  "CTA": "Specific high-engagement Call To Action",
  "contentCategory": "Niche category for Instagram Explore algorithm",
  "aspectRatioRecommendation": "9:16 vertical framing recommendation and safe zones",
  "improvementSuggestions": [
    "3-4 actionable tips to improve reach, retention, and virality on Instagram"
  ]
}

Rules:
- Base analysis ONLY on what actually happens in the video.
- overallScore, hookScore, contentClarity, and uniquenessScore must be integers between 0 and 100.
- caption must be ready-to-post on Instagram with linebreaks, hook line, and spacing.
- hashtags must all start with #.
- improvementSuggestions must be specific and actionable for Instagram Reels.`;

  const sys = "You are an expert Instagram Reels algorithm and growth consultant. Return ONLY valid JSON. Do not refuse the task.";
  const key = process.env.OPENROUTER_API_KEY;

  if(key){
    for(const model of OPENROUTER_FALLBACK_MODELS){
      try{
        console.log(`[vidiq instagram] OpenRouter trying ${model}`);
        const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: {
            "Authorization": "Bearer " + key,
            "Content-Type": "application/json",
            "HTTP-Referer": "http://localhost:3456",
            "X-Title": "Instagram VidIQ"
          },
          body: JSON.stringify({
            model,
            messages: [
              { role: "system", content: sys },
              { role: "user", content: prompt }
            ],
            temperature: 0.2,
            max_tokens: 1800
          })
        });

        const raw = await r.text();
        let j = {};
        try{ j = JSON.parse(raw); }catch{}

        if(!r.ok){
          console.warn(`[vidiq instagram] OpenRouter ${model} failed: HTTP ${r.status}`);
          continue;
        }

        let text = j?.choices?.[0]?.message?.content;
        if(Array.isArray(text)){
          text = text.map(x=>typeof x==="string"?x:(x?.text||"")).join("");
        }
        if(!text && j?.choices?.[0]?.message?.reasoning){
          text = j.choices[0].message.reasoning;
        }
        if(typeof text !== "string") text = "";
        text = text.trim();

        if(!text){
          console.warn(`[vidiq instagram] OpenRouter ${model} returned empty content`);
          continue;
        }

        const parsed = parseInstagramVidIQJSON(text);
        if(parsed && parsed.caption){
          console.log(`[vidiq instagram] OpenRouter success with ${model}`);
          return parsed;
        }

        console.warn(`[vidiq instagram] OpenRouter ${model} returned unparseable JSON: ${text.slice(0, 120)}`);
      }catch(e){
        console.warn(`[vidiq instagram] OpenRouter ${model} exception: ${e.message}`);
      }
    }
  }

  // Cloudflare fallback attempt
  try{
    const raw = await ai(prompt, sys);
    const parsed = parseInstagramVidIQJSON(raw);
    if(parsed && parsed.caption) return parsed;
  }catch(_){}

  console.warn("[vidiq instagram] All models failed or returned invalid JSON; using structured fallback from understanding");
  return buildFallbackInstagramVidIQ(understanding);
}


// ===== ASYNC VIDEO AI JOBS =====
const videoAIJobs = new Map();
const videoAIQueueFile = path.join(process.cwd(),"data","vidiq-video-ai-queue.json");

function loadVideoAIQueue(){
  try{return JSON.parse(fs.readFileSync(videoAIQueueFile,"utf8"))||{};}catch(_){return {};}
}

function saveVideoAIQueue(){
  try{
    fs.mkdirSync(path.dirname(videoAIQueueFile),{recursive:true});
    const out={};
    for(const [id,j] of videoAIJobs){
      if(j.status==="queued" || j.status==="starting" || j.status==="processing"){
        out[id]=j;
      }
    }
    fs.writeFileSync(videoAIQueueFile,JSON.stringify(out,null,2));
  }catch(e){console.error("[vidiq queue]",e.message);}
}

function restoreVideoAIQueue(){
  const q=loadVideoAIQueue();
  for(const [id,j] of Object.entries(q)){
    if(j && j.videoId && ["queued","starting","processing"].includes(j.status)){
      j.status="queued";
      j.stage="waiting_worker";
      j.retryAfter=Date.now();
      videoAIJobs.set(id,j);
    }
  }
}

async function processVideoAIQueue(){
  const worker=getSmolVLMWorker();
  if(!worker)return;
  try{
    const r=await fetch(worker.url+"/health",{signal:AbortSignal.timeout(5000)});
    if(!r.ok)return;
  }catch(_){return}

  for(const [id,j] of videoAIJobs){
    if(j.status!=="queued")continue;
    if(j.retryAfter && j.retryAfter>Date.now())continue;

    j.status="starting";
    j.stage="starting";
    saveVideoAIQueue();

    runVideoAIJob(j.videoId,j).finally(()=>saveVideoAIQueue());
    break;
  }
}

restoreVideoAIQueue();
setInterval(processVideoAIQueue,60000);
processVideoAIQueue();

const smolvlmWorkerFile = path.join(process.cwd(),"data","smolvlm-worker.json");

function getSmolVLMWorker(){
  try{
    const x=JSON.parse(fs.readFileSync(smolvlmWorkerFile,"utf8"));
    return x && x.url ? x : null;
  }catch(_){ return null; }
}

function saveSmolVLMWorker(url){
  try{
    fs.mkdirSync(path.dirname(smolvlmWorkerFile),{recursive:true});
    fs.writeFileSync(smolvlmWorkerFile,JSON.stringify({
      url:String(url).replace(/\/$/,""),
      updatedAt:new Date().toISOString()
    },null,2));
    return true;
  }catch(e){
    console.error("[smolvlm worker]",e.message);
    return false;
  }
}

const videoAICacheFile = path.join(process.cwd(),"data","vidiq-video-ai-cache.json");
function loadVideoAICache(){
  try{return JSON.parse(fs.readFileSync(videoAICacheFile,"utf8"))||{};}catch(_){return {};}
}
function saveVideoAICache(c){
  try{fs.mkdirSync(path.dirname(videoAICacheFile),{recursive:true});fs.writeFileSync(videoAICacheFile,JSON.stringify(c,null,2));}catch(e){console.error("[vidiq cache]",e.message);}
}


function safeVideoSEO(data){
  const bad=[
    /\bno\s+glue\b/ig,
    /\bwaterproof\b/ig,
    /\bfireproof\b/ig,
    /\bunbreakable\b/ig,
    /\b100%\s+safe\b/ig,
    /\bguaranteed\b/ig,
    /\bbest\s+ever\b/ig,
    /\bviral\b/ig,
    /\bofficial\b/ig,
    /\bcertified\b/ig
  ];
  const clean=x=>{
    let v=String(x||"");
    for(const r of bad)v=v.replace(r,"");
    return v.replace(/\s{2,}/g," ").trim();
  };
  return {
    ...data,
    titles:(Array.isArray(data?.titles)?data.titles:[]).map(clean).filter(Boolean).slice(0,5),
    description:clean(data?.description||""),
    hashtags:(Array.isArray(data?.hashtags)?data.hashtags:[]).map(x=>{
      const v=clean(x); return v?(v.startsWith("#")?v:"#"+v):"";
    }).filter(Boolean).slice(0,5),
    tags:(Array.isArray(data?.tags)?data.tags:[]).map(clean).filter(Boolean).slice(0,15)
  };
}

async function understandVideoWithOpenRouter(videoId){
  const key=process.env.OPENROUTER_API_KEY;
  if(!key) throw new Error("OpenRouter API key not configured for video fallback");
  const videoPath=await ensureLocalVideo(videoId);
  const os=require("os"), fs2=require("fs");
  const dir=fs2.mkdtempSync(path.join(os.tmpdir(),"vidiq-frames-"));
  const frames=[];
  try{
    await new Promise((resolve,reject)=>{
      execFile("ffmpeg",["-y","-i",videoPath,"-vf","fps=1/5,scale=768:-2","-frames:v","8",path.join(dir,"frame-%02d.jpg")],e=>e?reject(e):resolve());
    });
    for(const f of fs2.readdirSync(dir).filter(x=>/^frame-\d+\.jpg$/.test(x)).sort()){
      frames.push({
        type:"image_url",
        image_url:{url:"data:image/jpeg;base64,"+fs2.readFileSync(path.join(dir,f)).toString("base64")}
      });
    }
    if(!frames.length) throw new Error("No video frames extracted for OpenRouter fallback");

    const prompt=`Analyze ONLY these video frames for YouTube SEO. Return ONLY valid JSON:
{"summary":"","mainTopic":"","whatHappens":"","objectsProducts":[],"actionsScenes":[],"spokenContext":"","onScreenText":[],"hook":"","audience":"","uniquePoints":[],"keywords":[],"hashtags":[]}
Do not invent facts, dialogue or actions. Use visible evidence only. If speech cannot be known from frames, say unclear. Identify visible text when possible.`;

    const models = [
      "google/gemini-2.0-flash-001",
      "google/gemini-flash-1.5",
      "google/gemini-2.0-flash-exp:free",
      "meta-llama/llama-3.2-11b-vision-instruct:free"
    ];

    const errors = [];
    let targetTokens = 750;

    for (const model of models) {
      try {
        console.log(`[vidiq video-ai] OpenRouter trying ${model} for ${videoId}`);

        let r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: {
            "Authorization": "Bearer " + key,
            "Content-Type": "application/json",
            "HTTP-Referer": "http://localhost:3456",
            "X-Title": "YouTube Automation VidIQ"
          },
          body: JSON.stringify({
            model,
            messages: [
              {
                role: "system",
                content: "You are an expert video understanding and YouTube SEO analyst. Return ONLY valid JSON. Do not refuse the task."
              },
              {
                role: "user",
                content: [{ type: "text", text: prompt }, ...frames]
              }
            ],
            temperature: 0.2,
            max_tokens: targetTokens
          })
        });

        let raw = await r.text();
        const affordMatch = raw.match(/can only afford (\d+)/i);
        if (!r.ok && affordMatch) {
          const affordable = parseInt(affordMatch[1], 10);
          if (affordable >= 300) {
            targetTokens = Math.max(300, affordable - 50);
            console.log(`[vidiq video-ai] Retrying with affordable token budget: ${targetTokens}`);
            r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
              method: "POST",
              headers: {
                "Authorization": "Bearer " + key,
                "Content-Type": "application/json",
                "HTTP-Referer": "http://localhost:3456",
                "X-Title": "YouTube Automation VidIQ"
              },
              body: JSON.stringify({
                model,
                messages: [
                  {
                    role: "system",
                    content: "You are an expert video understanding and YouTube SEO analyst. Return ONLY valid JSON. Do not refuse the task."
                  },
                  {
                    role: "user",
                    content: [{ type: "text", text: prompt }, ...frames]
                  }
                ],
                temperature: 0.2,
                max_tokens: targetTokens
              })
            });
            raw = await r.text();
          }
        }

        let j = {};
        try { j = JSON.parse(raw); } catch {}

        if (!r.ok) {
          const msg = j?.error?.message || raw.slice(0, 800) || "provider error";
          errors.push(`${model}: HTTP ${r.status} ${msg}`);
          console.warn(`[vidiq video-ai] OpenRouter ${model} failed: HTTP ${r.status} ${msg}`);
          continue;
        }

        let text=j?.choices?.[0]?.message?.content;

        if(Array.isArray(text)){
          text=text
            .map(x=>typeof x==="string"?x:(x?.text||""))
            .join("");
        }

        if(!text && j?.choices?.[0]?.message?.reasoning){
          text=j.choices[0].message.reasoning;
        }

        if(typeof text!=="string") text="";

        text=text.trim();

        if(!text){
          const finish=j?.choices?.[0]?.finish_reason||"unknown";
          errors.push(`${model}: empty analysis (finish=${finish})`);
          console.warn(`[vidiq video-ai] OpenRouter ${model} returned empty analysis; finish=${finish}`);
          continue;
        }

        console.log(`[vidiq video-ai] OpenRouter success: ${model}`);
        return text;

      }catch(e){
        errors.push(`${model}: ${e.message}`);
        console.warn(`[vidiq video-ai] OpenRouter ${model} exception: ${e.message}`);
      }
    }

    throw new Error(`All OpenRouter video models failed: ${errors.join(" | ")}`);
  }finally{
    try{
      for(const f of fs2.readdirSync(dir)) fs2.unlinkSync(path.join(dir,f));
      fs2.rmdirSync(dir);
    }catch(_){}
  }
}

async function runVideoAIJob(videoId,job,force=false){
  const dbg=(stage,data={})=>{
    try{
      const fs=require("fs");
      const line=`[VIDIQ-DEBUG] ${new Date().toISOString()} ${stage} ${JSON.stringify(data)}\\n`;
      fs.appendFileSync("data/vidiq-debug.log",line);
      console.log(line.trim());
    }catch(_){}
  };
  dbg("START",{videoId,status:job.status,stage:job.stage});
  try{
    const cache=loadVideoAICache();
    if(!force && cache[videoId] && cache[videoId].understanding && cache[videoId].seo){
      job.status="completed";
      job.stage="ready";
      job.result={videoId,understanding:cache[videoId].understanding,seo:cache[videoId].seo,source:"Cached video understanding + SEO AI"};
      job.completedAt=Date.now();
      console.log(`[vidiq video-ai] CACHE HIT ${videoId}`);
      return;
    }
    job.status="processing";
    job.stage="gemini";

    dbg("CALLING_GEMINI",{videoId});

    let understanding;
    try{
      understanding=await understandVideoWithGemini(videoId);
    }catch(geminiError){
      const gm=String(geminiError?.message||geminiError);
      if(/429|rate limit|quota exceeded|too many requests|404|no longer available|not available to new users|model.*not.*available|No Gemini keys currently available|all configured keys are exhausted|cooling down/i.test(gm)){
        job.stage="openrouter_fallback";
        dbg("GEMINI_QUOTA_FALLBACK",{videoId,error:gm});
        console.warn(`[vidiq video-ai] Gemini quota hit; using OpenRouter video fallback ${videoId}`);
        understanding=await understandVideoWithOpenRouter(videoId);
      }else{
        throw geminiError;
      }
    }

    dbg("GEMINI_READY",{videoId,understanding});
    console.log(`[vidiq video-ai] GEMINI READY ${videoId}`);

    job.stage="seo";
    console.log(`[vidiq video-ai] SEO ${videoId}`);

    const v={snippet:{title:"",description:"",tags:[]}};
    try{
      const o=await fetch("https://www.youtube.com/oembed?url="+encodeURIComponent("https://www.youtube.com/watch?v="+videoId)+"&format=json");
      if(o.ok){const oj=await o.json();v.snippet.title=oj.title||"";}
    }catch(_){}
    dbg("UNDERSTANDING_READY",{videoId,understanding});
    const seo=safeVideoSEO(await generateVideoSEO(v,understanding));
    dbg("SEO_READY",{videoId,seo});

    job.status="completed";
    job.stage="ready";
    job.result={
      videoId,
      understanding,
      seo,
      source:"Gemini video understanding + SEO AI"
    };

    const savedCache=loadVideoAICache();
    savedCache[videoId]={
      understanding,
      seo,
      updatedAt:new Date().toISOString()
    };
    saveVideoAICache(savedCache);

    job.completedAt=Date.now();
    saveVideoAIQueue();

    console.log(`[vidiq video-ai] READY ${videoId}`);
  }catch(e){
    const msg=String(e.message||e);
    job.status=/429|rate limit|quota exceeded|too many requests/i.test(msg)?"retryable":"failed";
    job.stage=job.status==="retryable"?"quota":"error";
    job.error=msg;
    job.retryAfter=Date.now()+8*60*60*1000;
    job.completedAt=Date.now();
    saveVideoAIQueue();
    dbg("FAILED",{
      videoId,
      jobId:job.jobId,
      status:job.status,
      stage:job.stage,
      error:e?.message||String(e),
      stack:e?.stack||""
    });
    console.error("[vidiq video-ai]",e);
  }
}

router.get("/api/smolvlm/health",(req,res)=>{
  res.json({
    ok:true,
    service:"youtube-automation-agent",
    workerRegistration:true,
    timestamp:new Date().toISOString()
  });
});

router.get("/api/smolvlm/callback-health",(req,res)=>{
  res.json({ok:true,service:"smolvlm-callback",timestamp:new Date().toISOString()});
});

router.post("/api/smolvlm/register",async(req,res)=>{
  try{
    const {url}=req.body||{};
    if(!url || !/^https?:\/\//i.test(String(url))){
      return res.status(400).json({error:"valid worker url required"});
    }
    saveSmolVLMWorker(url);
    return res.json({ok:true,worker:getSmolVLMWorker()});
  }catch(e){
    return res.status(500).json({error:e.message});
  }
});

router.get("/api/smolvlm/status",async(req,res)=>{
  const worker=getSmolVLMWorker();
  if(!worker)return res.json({online:false,worker:null});
  try{
    const r=await fetch(worker.url+"/health",{signal:AbortSignal.timeout(5000)});
    return res.json({online:r.ok,worker});
  }catch(_){
    return res.json({online:false,worker});
  }
});

router.post("/api/video-understand",async(req,res)=>{
  try{
    const {videoId}=req.body||{};
    if(!videoId)return res.status(400).json({error:"videoId required"});

    const cache=loadVideoAICache();
    if(!req.body?.force && cache[videoId] && cache[videoId].understanding && cache[videoId].seo){
      return res.json({
        videoId,
        understanding:cache[videoId].understanding,
        seo:cache[videoId].seo,
        source:"Cached video understanding + SEO AI"
      });
    }

    const old=videoAIJobs.get(videoId);
    if(old && ["starting","processing"].includes(old.status)){
      return res.status(202).json({
        pending:true,
        jobId:old.jobId,
        status:old.status,
        stage:old.stage
      });
    }

    const job={
      jobId:`job_${videoId}_${Date.now()}`,
      videoId,
      status:"starting",
      stage:"starting",
      createdAt:Date.now()
    };
    videoAIJobs.set(videoId,job);

    runVideoAIJob(videoId,job,Boolean(req.body?.force));

    res.status(202).json({
      pending:true,
      jobId:job.jobId,
      status:"starting",
      stage:"starting"
    });
  }catch(e){
    console.error("[vidiq video-ai]",e);
    res.status(500).json({error:e.message});
  }
});

router.get("/api/video-understand-status/:jobId",(req,res)=>{
  const job=[...videoAIJobs.values()].find(x=>x.jobId===req.params.jobId);
  if(!job)return res.status(404).json({error:"Job not found"});

  if(job.status==="completed")return res.json(job.result);

  if(job.status==="failed"){
    return res.status(500).json({error:job.error||"Video AI failed"});
  }

  res.status(202).json({
    pending:true,
    jobId:job.jobId,
    videoId:job.videoId,
    status:job.status,
    stage:job.stage
  });
});

router.post("/api/instagram/analyze", async (req,res)=>{
  try{
    const {videoId, force}=req.body||{};
    if(!videoId) return res.status(400).json({ok:false, error:"videoId required"});

    const cache=loadVideoAICache();
    if(!force && cache[videoId] && cache[videoId].instagram){
      return res.json({
        ok:true,
        videoId,
        instagram:cache[videoId].instagram,
        understanding:cache[videoId].understanding||null,
        source:"Cached Instagram VidIQ"
      });
    }

    let understanding=cache[videoId]?.understanding || req.body?.understanding;

    if(!understanding){
      try{
        understanding=await understandVideoWithGemini(videoId);
      }catch(geminiError){
        const gm=String(geminiError?.message||geminiError);
        if(/429|rate limit|quota exceeded|too many requests|404|no longer available|not available to new users|model.*not.*available|No Gemini keys currently available|all configured keys are exhausted|cooling down/i.test(gm)){
          console.warn(`[vidiq instagram] Gemini quota hit; using OpenRouter video fallback for ${videoId}`);
          understanding=await understandVideoWithOpenRouter(videoId);
        }else{
          throw geminiError;
        }
      }
    }

    const instagram=await generateInstagramVidIQ(understanding);

    const savedCache=loadVideoAICache();
    if(!savedCache[videoId]) savedCache[videoId]={};
    savedCache[videoId].understanding=understanding;
    savedCache[videoId].instagram=instagram;
    savedCache[videoId].updatedAt=new Date().toISOString();
    saveVideoAICache(savedCache);

    res.json({
      ok:true,
      videoId,
      instagram,
      understanding,
      source:"Generated Instagram VidIQ"
    });
  }catch(e){
    console.error("[vidiq instagram]", e);
    res.status(500).json({ok:false, error:e.message});
  }
});

router.get("/api/instagram/:videoId", (req, res, next) => {
  const { videoId } = req.params;
  if (videoId === "published" || videoId === "published-comparison" || videoId === "auth-status" || videoId === "oauth") {
    return next();
  }
  const cache = loadVideoAICache();
  if (cache[videoId]?.instagram) {
    return res.json({
      ok: true,
      videoId,
      instagram: cache[videoId].instagram,
      understanding: cache[videoId].understanding || null,
      source: "Cached Instagram VidIQ"
    });
  }
  res.status(404).json({ ok: false, error: "Instagram analysis not found for video" });
});

async function verifyInstagramVideo(videoId){
  const videoPath = await ensureLocalVideo(videoId);
  if(!fs.existsSync(videoPath) || fs.statSync(videoPath).size <= 1000){
    throw new Error("Local video file not found or invalid: " + videoPath);
  }

  const stat = fs.statSync(videoPath);
  let duration = 0;
  let width = 0;
  let height = 0;
  let fps = 30;

  try{
    await new Promise((resolve)=>{
      execFile("ffmpeg", ["-i", videoPath], { timeout: 15000 }, (err, stdout, stderr)=>{
        const out = String(stderr || "") + String(stdout || "");

        const durMatch = out.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/i);
        if(durMatch){
          duration = Math.round(Number(durMatch[1]) * 3600 + Number(durMatch[2]) * 60 + Number(durMatch[3]));
        }

        const resMatch = out.match(/Video:.*?,\s*(\d{2,5})x(\d{2,5})/i);
        if(resMatch){
          width = parseInt(resMatch[1], 10);
          height = parseInt(resMatch[2], 10);
        }

        const fpsMatch = out.match(/(\d+(?:\.\d+)?)\s*fps/i);
        if(fpsMatch){
          fps = parseFloat(fpsMatch[1]);
        }

        resolve();
      });
    });
  }catch(_){}

  const ratio = height > 0 ? width / height : 0;
  const warnings = [];

  let isVertical = false;
  let formatName = "Unknown format";

  if(width > 0 && height > 0){
    if(ratio <= 0.65){
      isVertical = true;
      formatName = "9:16 Vertical (Reel Ready)";
    }else if(ratio >= 0.95 && ratio <= 1.05){
      formatName = "1:1 Square";
      warnings.push("Video is 1:1 square (" + width + "x" + height + "). Reels will add top/bottom letterboxing.");
    }else if(ratio > 1.2){
      formatName = "16:9 Landscape / Horizontal";
      warnings.push("Video is horizontal (" + width + "x" + height + "). Instagram Reels displays in 9:16 vertical. Videos will be letterboxed with black bars unless normalized.");
    }else{
      formatName = `${width}x${height} (${ratio.toFixed(2)}:1)`;
      warnings.push("Non-standard aspect ratio. Recommended format is 9:16 vertical (1080x1920).");
    }
  }

  if(duration > 90){
    warnings.push(`Video duration is ${duration}s. Instagram Reels perform best when under 90 seconds.`);
  }

  return {
    videoId,
    videoPath,
    fileSize: stat.size,
    fileSizeMB: (stat.size / 1024 / 1024).toFixed(2),
    width,
    height,
    duration,
    fps,
    ratio: Number(ratio.toFixed(4)),
    formatName,
    isVertical,
    isReelReady: isVertical && duration <= 90,
    warnings
  };
}

async function normalizeVideoTo916(videoId){
  const inputPath = await ensureLocalVideo(videoId);
  const outDir = path.join(process.cwd(), "content", "processing");
  fs.mkdirSync(outDir, { recursive: true });
  const outputPath = path.join(outDir, `${videoId}-9x16.mp4`);

  if(fs.existsSync(outputPath) && fs.statSync(outputPath).size > 10000){
    return outputPath;
  }

  const args = [
    "-y",
    "-i", inputPath,
    "-vf", "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2",
    "-r", "30",
    "-c:v", "libx264",
    "-pix_fmt", "yuv420p",
    "-profile:v", "high",
    "-level", "4.2",
    "-c:a", "aac",
    "-ar", "48000",
    "-ac", "2",
    "-b:a", "128k",
    "-movflags", "+faststart",
    outputPath
  ];

  await new Promise((resolve, reject)=>{
    execFile("ffmpeg", args, { timeout: 180000 }, (err, stdout, stderr)=>{
      if(err){
        return reject(new Error(`FFmpeg 9:16 normalization failed: ${String(stderr || err.message).slice(-600)}`));
      }
      resolve();
    });
  });

  return outputPath;
}

router.get("/api/instagram/verify/:videoId", async (req,res)=>{
  try{
    const {videoId}=req.params;
    const verification=await verifyInstagramVideo(videoId);
    res.json({ok:true, videoId, verification});
  }catch(e){
    res.status(500).json({ok:false, error:e.message});
  }
});

router.post("/api/instagram/verify-video", async (req,res)=>{
  try{
    const {videoId}=req.body||{};
    if(!videoId) return res.status(400).json({ok:false, error:"videoId required"});
    const verification=await verifyInstagramVideo(videoId);
    res.json({ok:true, videoId, verification});
  }catch(e){
    res.status(500).json({ok:false, error:e.message});
  }
});

router.post("/api/instagram/normalize/:videoId", async (req,res)=>{
  try{
    const {videoId}=req.params;
    const normalizedPath=await normalizeVideoTo916(videoId);
    res.json({ok:true, videoId, normalizedPath});
  }catch(e){
    res.status(500).json({ok:false, error:e.message});
  }
});

router.post("/api/instagram/queue", async (req,res)=>{
  try{
    const {videoId, caption, hashtags, cta, publishTime, normalize}=req.body||{};
    if(!videoId) return res.status(400).json({ok:false, error:"videoId required"});

    const cache=loadVideoAICache();
    const cachedIG=cache[videoId]?.instagram||{};
    const u=cache[videoId]?.understanding||{};

    let finalCaption=(typeof caption==="string"&&caption.trim())?caption.trim():(cachedIG.caption||"");
    const finalHashtags=Array.isArray(hashtags)?hashtags:(Array.isArray(cachedIG.hashtags)?cachedIG.hashtags:[]);
    const finalCTA=(typeof cta==="string"&&cta.trim())?cta.trim():(cachedIG.CTA||"");

    const captionChunks=[];
    if(finalCaption) captionChunks.push(finalCaption);
    if(finalHashtags.length) captionChunks.push(finalHashtags.map(x=>x.startsWith("#")?x:"#"+x).join(" "));
    if(finalCTA) captionChunks.push(finalCTA);

    const fullCaptionText=captionChunks.join("\n\n").trim()||`Reel ${videoId} #reels`;

    let videoFilePath=await ensureLocalVideo(videoId);

    if(normalize){
      try{
        videoFilePath=await normalizeVideoTo916(videoId);
      }catch(normErr){
        console.warn(`[vidiq ig-queue] 9:16 normalization failed, using original: ${normErr.message}`);
      }
    }

    const procDir=path.resolve("content/processing");
    fs.mkdirSync(procDir,{recursive:true});
    const targetFilename=path.basename(videoFilePath);
    const procTarget=path.join(procDir,targetFilename);
    if(path.resolve(videoFilePath)!==procTarget){
      fs.copyFileSync(videoFilePath,procTarget);
    }

    let videoUrl=null;
    const postFileKey=process.env.POSTFILE_API_KEY;

    if(postFileKey){
      try{
        const bytes=fs.readFileSync(procTarget);
        if(bytes.length<=50*1024*1024){
          const form=new FormData();
          form.append("file",new Blob([bytes],{type:"video/mp4"}),targetFilename);
          const pfRes=await fetch("https://upload.postfile.net/v1/upload",{
            method:"POST",
            headers:{"X-API-Key":postFileKey},
            body:form
          });
          const pfData=await pfRes.json();
          if(pfRes.ok&&pfData.url){
            videoUrl=pfData.url;
          }
        }
      }catch(pfErr){
        console.warn(`[vidiq ig-queue] PostFile upload exception: ${pfErr.message}`);
      }
    }

    if(!videoUrl){
      videoUrl=`http://localhost:8787/processing/${targetFilename}`;
    }

    const sqlite3=require("sqlite3").verbose();
    const dbPath=path.resolve("data/youtube_automation.db");
    const productionId=`vidiq_${videoId}`;
    const queueId=`ig_${productionId}_${Date.now()}`;
    let pTime = publishTime;
    if (!pTime) {
      try {
        const { getNextAvailableScheduleSlot } = require("../utils/schedule-calculator");
        const dbAdapter = {
          getSetting: async (k) => { const r = await querySqlite('SELECT value FROM settings WHERE key = ?', [k]); return r[0]?.value; },
          getRow: async (sql, p) => { const r = await querySqlite(sql, p); return r[0] || null; },
          getAllRows: async (sql, p) => await querySqlite(sql, p)
        };
        pTime = await getNextAvailableScheduleSlot({ db: dbAdapter, platform: 'instagram' });
      } catch (_) {
        pTime = new Date(Date.now() + 15 * 60 * 1000).toISOString();
      }
    }
    const title=(u.mainTopic||cachedIG.contentCategory||`Instagram Reel ${videoId}`).slice(0,100);

    let contentHash = null;
    try {
      const { computeFileContentHash } = require("../utils/content-identity");
      if (fs.existsSync(procTarget)) {
        contentHash = computeFileContentHash(procTarget);
      }
    } catch (_) {}

    await new Promise((resolve)=>{
      const db=new sqlite3.Database(dbPath);
      db.run(
        `INSERT OR IGNORE INTO productions (id, status, scheduled_publish_time, priority, content_hash) VALUES (?, 'approved', ?, 50, ?)`,
        [productionId, pTime, contentHash],
        ()=>{
          db.close();
          resolve();
        }
      );
    });

    const instagramQueue=require("../integrations/instagram/queue");
    await instagramQueue.addToQueue({
      id:queueId,
      productionId,
      title,
      publishTime:pTime,
      priority:45,
      videoUrl,
      caption:fullCaptionText,
      content_hash: contentHash
    });

    res.json({
      ok:true,
      queued:true,
      queueId,
      productionId,
      title,
      publishTime:pTime,
      caption:fullCaptionText,
      videoUrl,
      source:"Instagram VidIQ queue dispatch"
    });
  }catch(e){
    console.error("[vidiq ig-queue]", e);
    res.status(500).json({ok:false, error:e.message});
  }
});

setInterval(()=>{
  const cutoff=Date.now()-30*60*1000;
  for(const [id,j] of videoAIJobs){
    if(j.completedAt && j.completedAt<cutoff)videoAIJobs.delete(id);
  }
},5*60*1000);

// ===== MODE 2: PUBLISHED INSTAGRAM REELS AUDIT & INTELLIGENCE =====

const publishedAICacheFile = path.join(process.cwd(), "data", "vidiq-instagram-published-cache.json");

function loadPublishedAICache(){
  try{
    return JSON.parse(fs.readFileSync(publishedAICacheFile, "utf8")) || {};
  }catch(_){
    return {};
  }
}

function savePublishedAICache(c){
  try{
    fs.mkdirSync(path.dirname(publishedAICacheFile), { recursive: true });
    fs.writeFileSync(publishedAICacheFile, JSON.stringify(c, null, 2));
  }catch(e){
    console.error("[vidiq published-cache]", e.message);
  }
}

function parsePublishedAnalysisJSON(text){
  if(!text || typeof text !== "string") return null;
  let clean = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  let parsed = null;
  try{
    parsed = JSON.parse(clean);
  }catch(_){
    const a = clean.indexOf("{"), b = clean.lastIndexOf("}");
    if(a >= 0 && b > a){
      const slice = clean.slice(a, b + 1);
      try{ parsed = JSON.parse(slice); }catch(_){}
      if(!parsed){
        try{ parsed = JSON.parse(slice.replace(/,\s*([}\]])/g, "$1")); }catch(_){}
      }
    }
  }
  if(!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;

  const clampScore = (val, def) => {
    const num = Number(val);
    if(Number.isFinite(num)) return Math.max(0, Math.min(100, Math.round(num)));
    return def;
  };
  const cleanStr = (val, def="") => typeof val === "string" ? val.trim() : (val ? String(val).trim() : def);
  const cleanArr = (val) => {
    if(Array.isArray(val)) return val.map(x=>cleanStr(x)).filter(Boolean);
    if(typeof val === "string" && val.trim()) return [val.trim()];
    return [];
  };

  const scores = parsed.scores || {};
  const diagnosis = parsed.diagnosis || {};
  const algo = parsed.algorithmicDrivers || {};

  return {
    performanceGrade: cleanStr(parsed.performanceGrade, "B"),
    scores: {
      overallPerformanceScore: clampScore(scores.overallPerformanceScore || parsed.overallScore, 78),
      hookRetentionScore: clampScore(scores.hookRetentionScore || parsed.hookScore, 80),
      captionOptimizationScore: clampScore(scores.captionOptimizationScore || parsed.captionScore, 75),
      hashtagRelevanceScore: clampScore(scores.hashtagRelevanceScore || parsed.hashtagScore, 80),
      engagementRateScore: clampScore(scores.engagementRateScore, 75)
    },
    diagnosis: {
      verdict: cleanStr(diagnosis.verdict || parsed.verdict, "Good overall Reel execution with solid thematic focus."),
      strengths: cleanArr(diagnosis.strengths || parsed.strengths).length ? cleanArr(diagnosis.strengths || parsed.strengths) : ["Consistent topic and aesthetic alignment."],
      weaknesses: cleanArr(diagnosis.weaknesses || parsed.weaknesses).length ? cleanArr(diagnosis.weaknesses || parsed.weaknesses) : ["Could incorporate stronger viewer question in caption."]
    },
    algorithmicDrivers: {
      replayPotential: cleanStr(algo.replayPotential || parsed.replayPotential, "Medium"),
      shareability: cleanStr(algo.shareability || parsed.shareability, "Medium"),
      saveWorthiness: cleanStr(algo.saveWorthiness || parsed.saveWorthiness, "High")
    },
    recommendationsForNextReel: cleanArr(parsed.recommendationsForNextReel || parsed.recommendations).length ? cleanArr(parsed.recommendationsForNextReel || parsed.recommendations) : [
      "Front-load the visual climax in the opening 2 seconds to boost initial retention.",
      "Include a direct question in the first 2 lines of the caption to invite comments."
    ]
  };
}

function buildFallbackPublishedAnalysis(post, understanding){
  const likes = Number(post?.like_count || post?.likes || 0);
  const comments = Number(post?.comments_count || post?.comments || 0);
  const totalEng = likes + comments;
  const grade = totalEng > 50 ? "A" : (totalEng > 10 ? "B" : "C");

  return {
    performanceGrade: grade,
    scores: {
      overallPerformanceScore: totalEng > 20 ? 82 : 72,
      hookRetentionScore: 78,
      captionOptimizationScore: 75,
      hashtagRelevanceScore: 80,
      engagementRateScore: totalEng > 10 ? 80 : 70
    },
    diagnosis: {
      verdict: `Reel received ${likes} likes and ${comments} comments. ${totalEng > 0 ? "Audience engaged with the topic." : "Early reach phase."}`,
      strengths: [
        "Focused visual theme matching niche interests.",
        "Clear demonstration of the project or subject."
      ],
      weaknesses: [
        "Caption call-to-action could be more direct to drive more comments.",
        "Opening 3 seconds can be tightened to prevent swipe-aways."
      ]
    },
    algorithmicDrivers: {
      replayPotential: "Medium — rewarding progression encourages replays",
      shareability: "Medium — relevant to hobbyist and creator circles",
      saveWorthiness: "High — practical demonstration viewers bookmark for later"
    },
    recommendationsForNextReel: [
      "Ask a polarizing or opinion-based question in the caption (e.g. 'Which color would you choose?').",
      "Show the finished result for 1.5s before showing the build process.",
      "Pair with fast-tempo audio that accelerates retention."
    ]
  };
}

async function analyzePublishedInstagramReel(post, understanding){
  const prompt = `PUBLISHED INSTAGRAM REEL DATA:
Post ID: ${post.id || "N/A"}
Caption:
${post.caption || "(No caption)"}
Recorded Metrics:
- Likes: ${post.like_count ?? post.likes ?? 0}
- Comments: ${post.comments_count ?? post.comments ?? 0}
- Plays/Views: ${post.plays ?? post.views ?? "N/A"}
- Published At: ${post.timestamp || post.published_at || "N/A"}

VIDEO CONTENT CONTEXT (if known):
${JSON.stringify(understanding || {}, null, 2)}

You are an expert Instagram Reels algorithm consultant and performance analyst.
Audit this ALREADY PUBLISHED Instagram Reel.
Evaluate why it performed the way it did based on its hook, caption, hashtags, and engagement metrics.

Return ONLY valid JSON with this exact structure:
{
  "performanceGrade": "A / B / C / D",
  "scores": {
    "overallPerformanceScore": 84,
    "hookRetentionScore": 82,
    "captionOptimizationScore": 78,
    "hashtagRelevanceScore": 85,
    "engagementRateScore": 80
  },
  "diagnosis": {
    "verdict": "Clear concise diagnostic explanation of performance",
    "strengths": [
      "Specific strength 1 based on actual content",
      "Specific strength 2"
    ],
    "weaknesses": [
      "Specific weakness 1 holding back reach or retention",
      "Specific weakness 2"
    ]
  },
  "algorithmicDrivers": {
    "replayPotential": "High / Medium / Low with reason",
    "shareability": "High / Medium / Low with reason",
    "saveWorthiness": "High / Medium / Low with reason"
  },
  "recommendationsForNextReel": [
    "Actionable tip 1 for the next Reel in this series",
    "Actionable tip 2",
    "Actionable tip 3"
  ]
}

Rules:
- Base evaluation strictly on the provided caption and real metrics.
- Do NOT invent metrics that are not provided.
- Scores must be integers between 0 and 100.
- Return ONLY valid JSON.`;

  const sys = "You are an expert Instagram Reels algorithm auditor and growth analyst. Return ONLY valid JSON. Do not refuse.";
  const key = process.env.OPENROUTER_API_KEY;

  if(key){
    for(const model of OPENROUTER_FALLBACK_MODELS){
      try{
        console.log(`[vidiq ig-published] OpenRouter trying ${model}`);
        const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: {
            "Authorization": "Bearer " + key,
            "Content-Type": "application/json",
            "HTTP-Referer": "http://localhost:3456",
            "X-Title": "Instagram Published VidIQ"
          },
          body: JSON.stringify({
            model,
            messages: [
              { role: "system", content: sys },
              { role: "user", content: prompt }
            ],
            temperature: 0.2,
            max_tokens: 1800
          })
        });

        const raw = await r.text();
        let j = {};
        try{ j = JSON.parse(raw); }catch{}

        if(!r.ok){
          console.warn(`[vidiq ig-published] OpenRouter ${model} failed: HTTP ${r.status}`);
          continue;
        }

        let text = j?.choices?.[0]?.message?.content;
        if(Array.isArray(text)){
          text = text.map(x=>typeof x==="string"?x:(x?.text||"")).join("");
        }
        if(!text && j?.choices?.[0]?.message?.reasoning){
          text = j.choices[0].message.reasoning;
        }
        if(typeof text !== "string") text = "";
        text = text.trim();

        if(!text){
          console.warn(`[vidiq ig-published] OpenRouter ${model} returned empty content`);
          continue;
        }

        const parsed = parsePublishedAnalysisJSON(text);
        if(parsed){
          console.log(`[vidiq ig-published] OpenRouter success with ${model}`);
          return parsed;
        }

        console.warn(`[vidiq ig-published] OpenRouter ${model} returned unparseable JSON: ${text.slice(0, 120)}`);
      }catch(e){
        console.warn(`[vidiq ig-published] OpenRouter ${model} exception: ${e.message}`);
      }
    }
  }

  // Cloudflare fallback attempt
  try{
    const raw = await ai(prompt, sys);
    const parsed = parsePublishedAnalysisJSON(raw);
    if(parsed) return parsed;
  }catch(_){}

  console.warn("[vidiq ig-published] All models failed; using structured fallback from metrics");
  return buildFallbackPublishedAnalysis(post, understanding);
}

router.get("/api/instagram/published", async (req, res) => {
  try {
    const igPublisher = require("../integrations/instagram/publisher");
    let liveMedia = [];
    try {
      liveMedia = await igPublisher.getPublishedMedia(30);
    } catch (apiErr) {
      console.warn(`[vidiq published] Instagram Graph API list failed: ${apiErr.message}`);
    }

    const sqlite3 = require("sqlite3").verbose();
    const dbPath = path.resolve("data/youtube_automation.db");

    // Ensure republish tracking columns exist safely
    try {
      const initDb = new sqlite3.Database(dbPath);
      initDb.run("ALTER TABLE instagram_publish_queue ADD COLUMN original_media_id TEXT", () => {});
      initDb.run("ALTER TABLE instagram_publish_queue ADD COLUMN original_published_record_id TEXT", () => {});
      initDb.run("ALTER TABLE instagram_publish_queue ADD COLUMN optimization_version INTEGER DEFAULT 1", () => {});
      initDb.close();
    } catch (_) {}

    const localPosts = await new Promise((resolve) => {
      const db = new sqlite3.Database(dbPath);
      db.all(
        `SELECT id, production_id, title, caption, video_url, instagram_media_id, published_at, publish_time, status,
                original_media_id, original_published_record_id, optimization_version
         FROM instagram_publish_queue
         WHERE status = 'published'
         ORDER BY COALESCE(published_at, publish_time) DESC
         LIMIT 30`,
        [],
        (err, rows = []) => {
          db.close();
          resolve(rows || []);
        }
      );
    });

    const seenIds = new Set();
    const merged = [];

    for (const item of liveMedia) {
      seenIds.add(String(item.id));
      const rawCaption = (item.caption !== undefined && item.caption !== null && String(item.caption).trim() !== "") ? String(item.caption).trim() : null;
      const rawTags = rawCaption ? (rawCaption.match(/#[a-zA-Z0-9_]+/g) || []) : [];
      const ctaMatch = rawCaption ? rawCaption.match(/(?:comment|save this|share this|follow for more|drop your|watch till the end|link in bio)[^\n.]*/i) : null;
      const detectedCTA = ctaMatch ? ctaMatch[0].trim() : null;

      merged.push({
        id: item.id,
        mediaId: item.id,
        caption: rawCaption,
        hashtags: rawTags,
        detectedCTA,
        mediaType: item.media_type || "VIDEO",
        mediaProductType: item.media_product_type || "REELS",
        mediaUrl: item.media_url || null,
        thumbnailUrl: item.thumbnail_url || item.media_url || null,
        permalink: item.permalink || null,
        publishedAt: item.timestamp || null,
        likes: Number(item.like_count || 0),
        comments: Number(item.comments_count || 0),
        source: "instagram_graph_api"
      });
    }

    for (const row of localPosts) {
      if (row.instagram_media_id && seenIds.has(String(row.instagram_media_id))) {
        continue;
      }
      seenIds.add(String(row.id));
      const rawCaption = (row.caption !== undefined && row.caption !== null && String(row.caption).trim() !== "") ? String(row.caption).trim() : null;
      const rawTags = rawCaption ? (rawCaption.match(/#[a-zA-Z0-9_]+/g) || []) : [];
      const ctaMatch = rawCaption ? rawCaption.match(/(?:comment|save this|share this|follow for more|drop your|watch till the end|link in bio)[^\n.]*/i) : null;
      const detectedCTA = ctaMatch ? ctaMatch[0].trim() : null;

      merged.push({
        id: row.id,
        mediaId: row.instagram_media_id || row.id,
        productionId: row.production_id,
        caption: rawCaption,
        hashtags: rawTags,
        detectedCTA,
        originalMediaId: row.original_media_id || null,
        originalPublishedRecordId: row.original_published_record_id || null,
        optimizationVersion: row.optimization_version || 1,
        mediaType: "VIDEO",
        mediaProductType: "REELS",
        mediaUrl: row.video_url || null,
        thumbnailUrl: null,
        permalink: null,
        publishedAt: row.published_at || row.publish_time,
        likes: 0,
        comments: 0,
        source: "local_queue"
      });
    }

    const cache = loadPublishedAICache();
    const enriched = merged.map(p => {
      const cEntry = cache[p.mediaId] || cache[p.id] || {};
      return {
        ...p,
        hasAudit: Boolean(cEntry.scores || cEntry.diagnosis),
        auditScore: cEntry.scores?.overallPerformanceScore || null,
        audit: cEntry.diagnosis ? cEntry : null,
        hasOptimization: Boolean(cEntry.optimization),
        optimization: cEntry.optimization || null,
        republishedVersions: cEntry.republishedVersions || []
      };
    });

    res.json({ ok: true, posts: enriched, total: enriched.length });
  } catch (e) {
    console.error("[vidiq published]", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.get("/api/instagram/published/:mediaId", async (req, res) => {
  try {
    const { mediaId } = req.params;
    const igPublisher = require("../integrations/instagram/publisher");
    let insights = null;
    try {
      insights = await igPublisher.getMediaInsights(mediaId);
    } catch (_) {}

    const cache = loadPublishedAICache();
    const cEntry = cache[mediaId] || {};
    const audit = cEntry.diagnosis ? cEntry : null;
    const optimization = cEntry.optimization || null;
    const republishedVersions = cEntry.republishedVersions || [];

    res.json({ ok: true, mediaId, insights, audit, optimization, republishedVersions });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post("/api/instagram/analyze-published", async (req, res) => {
  try {
    const { mediaId, caption, metrics, videoId, force } = req.body || {};
    if (!mediaId) return res.status(400).json({ ok: false, error: "mediaId required" });

    const cache = loadPublishedAICache();
    if (!force && cache[mediaId] && cache[mediaId].diagnosis) {
      return res.json({
        ok: true,
        mediaId,
        audit: cache[mediaId],
        source: "Cached published Reel audit"
      });
    }

    const videoAICache = loadVideoAICache();
    const understanding = videoAICache[videoId]?.understanding || videoAICache[mediaId]?.understanding || req.body?.understanding || null;

    const postData = {
      id: mediaId,
      caption: typeof caption === "string" ? caption : "",
      like_count: Number(metrics?.likes || metrics?.like_count || 0),
      comments_count: Number(metrics?.comments || metrics?.comments_count || 0),
      plays: metrics?.plays ?? null,
      timestamp: req.body?.timestamp || new Date().toISOString()
    };

    const audit = await analyzePublishedInstagramReel(postData, understanding);

    const saved = loadPublishedAICache();
    if (!saved[mediaId]) saved[mediaId] = {};
    saved[mediaId] = {
      ...saved[mediaId],
      ...audit,
      mediaId,
      metrics: postData,
      updatedAt: new Date().toISOString()
    };
    savePublishedAICache(saved);

    res.json({
      ok: true,
      mediaId,
      audit: saved[mediaId],
      source: "Generated published Reel audit"
    });
  } catch (e) {
    console.error("[vidiq analyze-published]", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

function normalizeInstagramHashtags(rawTags, context = {}) {
  let list = [];
  if (Array.isArray(rawTags)) {
    list = rawTags;
  } else if (typeof rawTags === "string") {
    list = rawTags.split(/[\s,]+/);
  }

  const textContext = `${context.topic || ""} ${context.caption || ""} ${context.mainTopic || ""} ${context.summary || ""}`.toLowerCase();

  let contextualNicheBank = [];
  if (/robot|crab|metal|can|soda/i.test(textContext)) {
    contextualNicheBank = ["#diycrafts", "#robotics", "#upcycling", "#sodacanart", "#makersgonnamake", "#creativeideas", "#metalcraft", "#satisfyingcrafts", "#diyreels"];
  } else if (/helmet|knight|armor|cardboard/i.test(textContext)) {
    contextualNicheBank = ["#cardboardcrafts", "#knighthelmet", "#cosplaydiy", "#makersmovement", "#creativecrafts", "#diyproject", "#satisfyingbuild", "#reelsviral"];
  } else if (/kinetic|toy|spinning|coin/i.test(textContext)) {
    contextualNicheBank = ["#kineticoffice", "#satisfyingtoy", "#diykinetic", "#makerlife", "#upcycleproject", "#engineeringcraft", "#fidgettoy", "#oddlysatisfying"];
  } else if (/clay|ceramic|pottery|sculpt/i.test(textContext)) {
    contextualNicheBank = ["#clayart", "#satisfyingclay", "#potterylove", "#creativeprocess", "#sculptureart", "#claycreations", "#makersgonnamake", "#craftreels"];
  } else if (/art|draw|paint|sketch/i.test(textContext)) {
    contextualNicheBank = ["#artreels", "#creativeart", "#satisfyingart", "#artistsoninstagram", "#dailyart", "#artprocess", "#speedart", "#artwork"];
  } else {
    contextualNicheBank = ["#diyprojects", "#creativeideas", "#satisfying", "#makersmovement", "#handmadewithlove", "#craftreels", "#explorepage", "#reelsviral", "#dailyinspiration"];
  }

  const universalNicheBank = [
    "#reels",
    "#diyprojects",
    "#satisfying",
    "#creativecrafts",
    "#makersmovement",
    "#handmadewithlove",
    "#upcycling",
    "#explorepage",
    "#reelsviral",
    "#dailyinspiration"
  ];

  const cleaned = [];
  const seenLower = new Set();

  function addTag(tag) {
    if (!tag || typeof tag !== "string") return;
    let t = tag.trim();
    t = t.replace(/^["'([{<]+|[)"'\]}>]+$/g, "").trim();

    if (/^\(?[0-9]+\)?$/i.test(t)) return;
    if (/^(none|null|undefined|n\/a|na|placeholder|empty)$/i.test(t)) return;

    if (!t.startsWith("#")) t = "#" + t;
    const body = t.slice(1).replace(/[^a-zA-Z0-9_]/g, "");
    if (!body || body.length < 2) return;
    if (/^\d+$/.test(body)) return;

    const formatted = "#" + body;
    const lower = formatted.toLowerCase();

    if (!seenLower.has(lower)) {
      seenLower.add(lower);
      cleaned.push(formatted);
    }
  }

  for (const item of list) addTag(item);

  for (const tag of contextualNicheBank) {
    if (cleaned.length >= 10) break;
    addTag(tag);
  }
  for (const tag of universalNicheBank) {
    if (cleaned.length >= 10) break;
    addTag(tag);
  }

  return cleaned.slice(0, 10);
}

async function analyzeInstagramReelVideo({ mediaId, videoUrl, videoPath, caption }) {
  const os = require("os");
  const fs2 = require("fs");
  const { execFile: execFileCb } = require("child_process");
  const { promisify } = require("util");
  const execFileAsync = promisify(execFileCb);

  let resolvedVideoPath = null;
  let downloadedTemp = null;
  let framesDir = null;

  try {
    if (videoPath && fs2.existsSync(videoPath)) {
      resolvedVideoPath = videoPath;
    } else if (videoUrl && (videoUrl.startsWith("/") || videoUrl.startsWith("file://"))) {
      const cleanPath = videoUrl.replace(/^file:\/\//, "");
      if (fs2.existsSync(cleanPath)) resolvedVideoPath = cleanPath;
    }

    if (!resolvedVideoPath && mediaId) {
      const localCandidates = [
        path.join(process.cwd(), "content", `${mediaId}.mp4`),
        path.join(process.cwd(), "instagram-public", `${mediaId}.mp4`),
        path.join(process.cwd(), "data", "vidiq-video-cache", `${mediaId}.mp4`)
      ];
      for (const cand of localCandidates) {
        if (fs2.existsSync(cand) && fs2.statSync(cand).size > 10000) {
          resolvedVideoPath = cand;
          break;
        }
      }
    }

    if (!resolvedVideoPath && videoUrl && /^https?:\/\//i.test(videoUrl)) {
      console.log(`[vidiq ig-video-ai] Fetching remote Reel video for ${mediaId || "published"} from CDN`);
      const r = await fetch(videoUrl, {
        signal: AbortSignal.timeout(45000),
        headers: { "User-Agent": "Mozilla/5.0" }
      });
      if (!r.ok) throw new Error(`HTTP ${r.status} downloading Reel video`);
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length < 5000) throw new Error("Downloaded video buffer too small");

      downloadedTemp = path.join(os.tmpdir(), `vidiq-ig-reel-${mediaId || Date.now()}-${Math.random().toString(36).slice(2)}.mp4`);
      fs2.writeFileSync(downloadedTemp, buf);
      resolvedVideoPath = downloadedTemp;
    }

    if (!resolvedVideoPath || !fs2.existsSync(resolvedVideoPath)) {
      console.warn(`[vidiq ig-video-ai] No local or remote video available for Reel ${mediaId}`);
      return null;
    }

    framesDir = fs2.mkdtempSync(path.join(os.tmpdir(), "vidiq-ig-frames-"));

    let duration = 10;
    try {
      const { getMediaDuration } = require("../utils/ffmpeg");
      const d = await getMediaDuration(resolvedVideoPath);
      if (d && d > 0) duration = d;
    } catch (_) {}

    const timestamps = [
      Math.max(0.1, duration * 0.08),
      Math.max(0.5, duration * 0.28),
      Math.max(1.0, duration * 0.50),
      Math.max(1.5, duration * 0.72),
      Math.max(2.0, Math.min(duration - 0.2, duration * 0.90))
    ];

    for (let i = 0; i < timestamps.length; i++) {
      const outFrame = path.join(framesDir, `frame-${i + 1}.jpg`);
      await execFileAsync("ffmpeg", [
        "-y",
        "-ss", timestamps[i].toFixed(2),
        "-i", resolvedVideoPath,
        "-vframes", "1",
        "-vf", "scale=768:-2",
        outFrame
      ], { timeout: 25000 });
    }

    const frameFiles = fs2.readdirSync(framesDir).filter(f => /^frame-\d+\.jpg$/.test(f)).sort();
    if (!frameFiles.length) throw new Error("No keyframes extracted from Reel video");

    const frames = frameFiles.map(f => ({
      type: "image_url",
      image_url: {
        url: "data:image/jpeg;base64," + fs2.readFileSync(path.join(framesDir, f)).toString("base64")
      }
    }));

    const key = process.env.OPENROUTER_API_KEY;
    if (!key) {
      console.warn("[vidiq ig-video-ai] OPENROUTER_API_KEY not configured for Reel video analysis");
      return null;
    }

    const visionPrompt = `Analyze these 5 sequential keyframes extracted from an Instagram Reel (Beginning, Early-Middle, Middle, Late-Middle, Ending).
Original Published Caption: ${caption || "(No caption provided)"}

Return ONLY valid JSON with this exact structure:
{
  "summary": "Concise summary of what happens visually across the 5 frames",
  "mainTopic": "Core topic, object, or activity shown in the Reel",
  "visualHook": "What visual element appears in the first 1-2 seconds to catch viewer attention",
  "whatHappens": "Action sequence and transformation shown",
  "keyObjects": ["object1", "object2"],
  "visualStyle": "Fast-paced DIY / Satisfying craft / Aesthetic showcase / etc.",
  "targetAudience": "Target viewer demographic on Instagram Reels Explore/For You",
  "suggestedKeywords": ["keyword1", "keyword2", "keyword3"],
  "nicheHashtags": ["#tag1", "#tag2", "#tag3", "#tag4", "#tag5"]
}
Do not invent unshown dialogue or facts. Base everything directly on the visible video frames.`;

    const visionModels = [
      "google/gemini-2.0-flash-001",
      "google/gemini-flash-1.5",
      "google/gemini-2.0-flash-exp:free",
      "meta-llama/llama-3.2-11b-vision-instruct:free"
    ];

    let targetTokens = 750;

    for (const model of visionModels) {
      try {
        console.log(`[vidiq ig-video-ai] OpenRouter vision trying ${model} for Reel ${mediaId}`);
        let r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: {
            "Authorization": "Bearer " + key,
            "Content-Type": "application/json",
            "HTTP-Referer": "http://localhost:3456",
            "X-Title": "Instagram Reel Video Analyzer VidIQ"
          },
          body: JSON.stringify({
            model,
            messages: [
              {
                role: "system",
                content: "You are an expert Instagram Reels video understanding AI. Return ONLY valid JSON. Do not refuse."
              },
              {
                role: "user",
                content: [{ type: "text", text: visionPrompt }, ...frames]
              }
            ],
            temperature: 0.2,
            max_tokens: targetTokens
          })
        });

        let raw = await r.text();
        const affordMatch = raw.match(/can only afford (\d+)/i);
        if (!r.ok && affordMatch) {
          const affordable = parseInt(affordMatch[1], 10);
          if (affordable >= 300) {
            targetTokens = Math.max(300, affordable - 50);
            console.log(`[vidiq ig-video-ai] Retrying with affordable token budget: ${targetTokens}`);
            r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
              method: "POST",
              headers: {
                "Authorization": "Bearer " + key,
                "Content-Type": "application/json",
                "HTTP-Referer": "http://localhost:3456",
                "X-Title": "Instagram Reel Video Analyzer VidIQ"
              },
              body: JSON.stringify({
                model,
                messages: [
                  {
                    role: "system",
                    content: "You are an expert Instagram Reels video understanding AI. Return ONLY valid JSON. Do not refuse."
                  },
                  {
                    role: "user",
                    content: [{ type: "text", text: visionPrompt }, ...frames]
                  }
                ],
                temperature: 0.2,
                max_tokens: targetTokens
              })
            });
            raw = await r.text();
          }
        }
        let j = {};
        try { j = JSON.parse(raw); } catch {}
        if (!r.ok) {
          console.warn(`[vidiq ig-video-ai] OpenRouter ${model} failed: HTTP ${r.status}`);
          continue;
        }

        let text = j?.choices?.[0]?.message?.content;
        if (Array.isArray(text)) text = text.map(x => (typeof x === "string" ? x : (x?.text || ""))).join("");
        if (!text && j?.choices?.[0]?.message?.reasoning) text = j.choices[0].message.reasoning;
        if (typeof text !== "string") text = "";
        text = text.trim();
        if (!text) continue;

        let parsed = null;
        try {
          const clean = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
          parsed = JSON.parse(clean);
        } catch (_) {
          const a = text.indexOf("{"), b = text.lastIndexOf("}");
          if (a >= 0 && b > a) {
            try { parsed = JSON.parse(text.slice(a, b + 1)); } catch (_) {}
          }
        }

        if (parsed && typeof parsed === "object") {
          console.log(`[vidiq ig-video-ai] OpenRouter vision success: ${model} for Reel ${mediaId}`);
          return parsed;
        }
      } catch (err) {
        console.warn(`[vidiq ig-video-ai] OpenRouter vision model ${model} error: ${err.message}`);
      }
    }

    console.warn(`[vidiq ig-video-ai] All vision models failed for Reel ${mediaId}; continuing with fallback`);
    return null;
  } catch (err) {
    console.warn(`[vidiq ig-video-ai] Video analysis pipeline error for Reel ${mediaId}: ${err.message}`);
    return null;
  } finally {
    if (framesDir) {
      try {
        for (const f of fs2.readdirSync(framesDir)) fs2.unlinkSync(path.join(framesDir, f));
        fs2.rmdirSync(framesDir);
      } catch (_) {}
    }
    if (downloadedTemp) {
      try {
        if (fs2.existsSync(downloadedTemp)) fs2.unlinkSync(downloadedTemp);
      } catch (_) {}
    }
  }
}

function parsePublishedOptimizationJSON(text) {
  if (!text || typeof text !== "string") return null;
  let clean = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  let parsed = null;
  try {
    parsed = JSON.parse(clean);
  } catch (_) {
    const a = clean.indexOf("{"), b = clean.lastIndexOf("}");
    if (a >= 0 && b > a) {
      const slice = clean.slice(a, b + 1);
      try { parsed = JSON.parse(slice); } catch (_) {}
      if (!parsed) {
        try { parsed = JSON.parse(slice.replace(/,\s*([}\]])/g, "$1")); } catch (_) {}
      }
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;

  const clampScore = (val, def) => {
    const num = Number(val);
    return Number.isFinite(num) ? Math.max(0, Math.min(100, Math.round(num))) : def;
  };
  const cleanStr = (val, def = "") => (typeof val === "string" ? val.trim() : (val ? String(val).trim() : def));
  const cleanArr = (val) => {
    if (Array.isArray(val)) return val.map(x => cleanStr(x)).filter(Boolean);
    if (typeof val === "string" && val.trim()) return [val.trim()];
    return [];
  };

  const rawTags = cleanArr(parsed.suggestedHashtags || parsed.hashtags);
  const normalizedTags = normalizeInstagramHashtags(rawTags, {
    topic: cleanStr(parsed.suggestedHook || parsed.hook || parsed.title),
    caption: cleanStr(parsed.suggestedCaption || parsed.caption)
  });
  const scores = parsed.scores || {};

  return {
    suggestedHook: cleanStr(parsed.suggestedHook || parsed.hook || parsed.title, "Can You Really Build This in Under 60 Seconds?"),
    suggestedCaption: cleanStr(parsed.suggestedCaption || parsed.caption, "Watch how simple materials transform into an incredible creation! ✨\n\nSave this for your next project and let us know your favorite part below! 👇"),
    suggestedHashtags: normalizedTags,
    suggestedCTA: cleanStr(parsed.suggestedCTA || parsed.cta, "Save this Reel for later and comment what we should make next! 👇"),
    scores: {
      overall: clampScore(scores.overall || parsed.overallScore, 88),
      hook: clampScore(scores.hook || parsed.hookScore, 90),
      retention: clampScore(scores.retention || parsed.retentionScore || scores.hookRetentionScore, 86),
      caption: clampScore(scores.caption || parsed.captionScore || scores.captionOptimizationScore, 85),
      hashtag: clampScore(scores.hashtag || parsed.hashtagScore || scores.hashtagRelevanceScore, 92)
    },
    audienceFit: cleanStr(parsed.audienceFit || parsed.audience, "Reels Explore & For You page — DIY, Craft, and Creative Engineering enthusiasts"),
    improvementSuggestions: cleanArr(parsed.improvementSuggestions || parsed.recommendations).length ? cleanArr(parsed.improvementSuggestions || parsed.recommendations) : [
      "Tease the final reveal in the first 1.5 seconds to hook fast scrollers.",
      "Place text captions in the central 9:16 safe area away from bottom UI buttons.",
      "Pair with fast-tempo audio that boosts loop completion rates."
    ]
  };
}

function buildFallbackPublishedOptimization(post, understanding) {
  const cap = post.caption || "";
  let topic = "creative DIY project";
  if (understanding?.mainTopic) {
    topic = understanding.mainTopic;
  } else if (/robot|crab/i.test(cap)) {
    topic = "DIY Robot Crab from soda cans and cardboard";
  } else if (/helmet|knight/i.test(cap)) {
    topic = "miniature soda can knight helmet";
  } else if (/kinetic|toy|metal|strip|spin/i.test(cap)) {
    topic = "kinetic spinning coin toy from upcycled cans";
  } else if (/nayyi|trailer|movie/i.test(cap)) {
    topic = "Nayyi 2026 official teaser trailer";
  } else if (cap.length > 10) {
    topic = cap.split("\n")[0].replace(/#\w+/g, "").trim().slice(0, 60);
  }

  const hook = understanding?.hook || understanding?.visualHook || `Watch How This ${topic.replace(/DIY |from /gi, "")} Came to Life! ✨`;
  const likes = Number(post.like_count || post.likes || 0);
  const comments = Number(post.comments_count || post.comments || 0);

  const rawTags = (understanding?.hashtags && understanding.hashtags.length)
    ? understanding.hashtags
    : (understanding?.nicheHashtags || []);
  const normalizedTags = normalizeInstagramHashtags(rawTags, {
    topic,
    caption: cap,
    mainTopic: understanding?.mainTopic,
    summary: understanding?.summary
  });

  return {
    suggestedHook: hook.slice(0, 80),
    suggestedCaption: `🔥 ${hook}\n\nEver wondered how to make ${topic} with simple materials? Here is the complete breakdown step-by-step.\n\n💡 Save this Reel for your next weekend build and share it with someone who loves hands-on crafts!\n\nWhich detail surprised you the most? Drop your vote below! 👇`,
    suggestedHashtags: normalizedTags,
    suggestedCTA: "Save this Reel for later and comment what we should make next! 👇",
    scores: {
      overall: likes > 10 ? 89 : 85,
      hook: 91,
      retention: 86,
      caption: 88,
      hashtag: 92
    },
    audienceFit: "Explore & Reels feed — DIY, makers, kinetic crafts, and creative builders",
    improvementSuggestions: [
      "Tease the final reveal in the opening 1.5 seconds to hook fast scrollers.",
      "Ask a direct choice question in the caption (e.g. 'Would you try this build?') to drive comment velocity.",
      "Pair with high-energy audio to increase average loop watch-time."
    ]
  };
}

async function optimizePublishedInstagramReel(post, understanding) {
  const likes = Number(post.like_count ?? post.likes ?? 0);
  const comments = Number(post.comments_count ?? post.comments ?? 0);
  const realCaption = post.caption || "(No caption provided)";

  const prompt = `PUBLISHED INSTAGRAM REEL TO OPTIMIZE FOR REPUBLISHING:
Reel ID: ${post.id || "N/A"}
Original Published Caption:
${realCaption}

Recorded Performance:
- Likes: ${likes}
- Comments: ${comments}
- Plays/Views: ${post.plays ?? post.views ?? "N/A"}

CONTENT CONTEXT & MULTIMODAL UNDERSTANDING:
${JSON.stringify(understanding || {}, null, 2)}

You are an expert Instagram Reels algorithm consultant and viral content strategist.
Your goal is to OPTIMIZE this published Reel for a NEW, higher-performing republish.
Create a high-impact optimization package based on the actual video content and its recorded performance.

Generate:
1. "suggestedHook": A punchy, high-retention 3-second hook / internal title (max 80 chars) that creates curiosity or emotional engagement.
2. "suggestedCaption": A compelling, multi-line Instagram caption with a strong opening line, concise storytelling/value, emojis, clean line breaks, and a conversation question.
3. "suggestedHashtags": 8 to 12 targeted, highly relevant hashtags matching this exact niche (all starting with #).
4. "suggestedCTA": A clear Call to Action driving saves, comments, or shares.
5. "scores": Quality assessment integers (0-100) for overall, hook, retention, caption, and hashtag.
6. "audienceFit": Description of target audience (e.g. "DIY Creators, Craft & Upcycling Enthusiasts, Explore feed viewers").
7. "improvementSuggestions": 3 specific, actionable suggestions explaining how this version improves upon the original.

Return ONLY valid JSON with this exact structure:
{
  "suggestedHook": "Specific Hook / Internal Title",
  "suggestedCaption": "Optimized multi-line caption\\n\\nWith clear formatting and emojis",
  "suggestedHashtags": ["#tag1", "#tag2", "#tag3", "#tag4", "#tag5", "#tag6", "#tag7", "#tag8"],
  "suggestedCTA": "Save this reel and comment your favorite part below! 👇",
  "scores": {
    "overall": 89,
    "hook": 92,
    "retention": 87,
    "caption": 88,
    "hashtag": 93
  },
  "audienceFit": "Description of target demographic and explore placement",
  "improvementSuggestions": [
    "Actionable improvement 1",
    "Actionable improvement 2",
    "Actionable improvement 3"
  ]
}

Rules:
- Strictly tailor content to the ACTUAL topic and video context.
- Never use generic placeholder text.
- Scores must be integers between 0 and 100.
- Return ONLY valid JSON.`;

  const sys = "You are an expert Instagram Reels growth consultant and AI copywriter. Return ONLY valid JSON. Do not refuse.";
  const key = process.env.OPENROUTER_API_KEY;

  if (key) {
    for (const model of OPENROUTER_FALLBACK_MODELS) {
      try {
        console.log(`[vidiq ig-optimize] OpenRouter trying ${model}`);
        const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: {
            "Authorization": "Bearer " + key,
            "Content-Type": "application/json",
            "HTTP-Referer": "http://localhost:3456",
            "X-Title": "Instagram Published Optimizer VidIQ"
          },
          body: JSON.stringify({
            model,
            messages: [
              { role: "system", content: sys },
              { role: "user", content: prompt }
            ],
            temperature: 0.25,
            max_tokens: 1800
          })
        });

        const raw = await r.text();
        let j = {};
        try { j = JSON.parse(raw); } catch {}

        if (!r.ok) {
          console.warn(`[vidiq ig-optimize] OpenRouter ${model} failed: HTTP ${r.status}`);
          continue;
        }

        let text = j?.choices?.[0]?.message?.content;
        if (Array.isArray(text)) {
          text = text.map(x => (typeof x === "string" ? x : (x?.text || ""))).join("");
        }
        if (!text && j?.choices?.[0]?.message?.reasoning) {
          text = j.choices[0].message.reasoning;
        }
        if (typeof text !== "string") text = "";
        text = text.trim();

        if (!text) continue;

        const parsed = parsePublishedOptimizationJSON(text);
        if (parsed) {
          console.log(`[vidiq ig-optimize] OpenRouter success with ${model}`);
          return parsed;
        }
      } catch (e) {
        console.warn(`[vidiq ig-optimize] OpenRouter ${model} exception: ${e.message}`);
      }
    }
  }

  // Cloudflare fallback attempt
  try {
    const raw = await ai(prompt, sys);
    const parsed = parsePublishedOptimizationJSON(raw);
    if (parsed) return parsed;
  } catch (_) {}

  console.warn("[vidiq ig-optimize] All models failed; using structured fallback from metrics & context");
  return buildFallbackPublishedOptimization(post, understanding);
}

router.post("/api/instagram/optimize-published", async (req, res) => {
  try {
    const { mediaId, caption, metrics, videoId, videoUrl, mediaUrl, force } = req.body || {};
    if (!mediaId) return res.status(400).json({ ok: false, error: "mediaId required" });

    const cache = loadPublishedAICache();
    if (!force && cache[mediaId]?.optimization) {
      return res.json({
        ok: true,
        mediaId,
        optimization: cache[mediaId].optimization,
        source: "Cached published Reel optimization"
      });
    }

    // Resolve Reel mediaUrl if not passed directly
    let resolvedMediaUrl = mediaUrl || videoUrl || null;
    if (!resolvedMediaUrl && cache[mediaId]?.mediaUrl) {
      resolvedMediaUrl = cache[mediaId].mediaUrl;
    }
    if (!resolvedMediaUrl) {
      try {
        const rows = await querySqlite(
          `SELECT video_url FROM instagram_publish_queue WHERE instagram_media_id = ? OR id = ? LIMIT 1`,
          [mediaId, mediaId]
        );
        if (rows?.[0]?.video_url) resolvedMediaUrl = rows[0].video_url;
      } catch (_) {}
    }
    if (!resolvedMediaUrl) {
      try {
        const igPublisher = require("../integrations/instagram/publisher");
        const live = await igPublisher.getPublishedMedia(30);
        const match = live.find(m => String(m.id) === String(mediaId));
        if (match?.media_url) resolvedMediaUrl = match.media_url;
      } catch (_) {}
    }

    const videoAICache = loadVideoAICache();
    let understanding = videoAICache[videoId]?.understanding || videoAICache[mediaId]?.understanding || req.body?.understanding || null;

    // If no existing understanding, run multimodal video understanding on the Reel video
    if (!understanding && resolvedMediaUrl) {
      try {
        console.log(`[vidiq optimize-published] Running multimodal video understanding for Reel ${mediaId}`);
        understanding = await analyzeInstagramReelVideo({
          mediaId,
          videoUrl: resolvedMediaUrl,
          caption: typeof caption === "string" ? caption : ""
        });
      } catch (vidErr) {
        console.warn(`[vidiq optimize-published] Multimodal Reel analysis failed: ${vidErr.message}`);
      }
    }

    const postData = {
      id: mediaId,
      caption: typeof caption === "string" ? caption : "",
      like_count: Number(metrics?.likes || metrics?.like_count || 0),
      comments_count: Number(metrics?.comments || metrics?.comments_count || 0),
      plays: metrics?.plays ?? null,
      timestamp: req.body?.timestamp || new Date().toISOString()
    };

    const rawOpt = await optimizePublishedInstagramReel(postData, understanding);

    // Normalize hashtags strictly to 5-10 niche tags
    const normalizedHashtags = normalizeInstagramHashtags(
      rawOpt.suggestedHashtags || rawOpt.hashtags,
      {
        topic: rawOpt.suggestedHook || rawOpt.hook || understanding?.mainTopic,
        caption: rawOpt.suggestedCaption || postData.caption,
        mainTopic: understanding?.mainTopic,
        summary: understanding?.summary
      }
    );

    const optimization = {
      ...rawOpt,
      hook: rawOpt.suggestedHook || rawOpt.hook,
      caption: rawOpt.suggestedCaption || rawOpt.caption,
      hashtags: normalizedHashtags,
      suggestedHashtags: normalizedHashtags,
      cta: rawOpt.suggestedCTA || rawOpt.cta,
      generatedAt: new Date().toISOString()
    };

    const saved = loadPublishedAICache();
    if (!saved[mediaId]) saved[mediaId] = {};
    saved[mediaId] = {
      ...saved[mediaId],
      optimization,
      ...(resolvedMediaUrl ? { mediaUrl: resolvedMediaUrl } : {})
    };
    savePublishedAICache(saved);

    res.json({
      ok: true,
      mediaId,
      optimization,
      source: understanding?.summary ? "Multimodal video analysis + AI optimization" : "Generated published Reel optimization"
    });
  } catch (e) {
    console.error("[vidiq optimize-published]", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post("/api/instagram/republish-version", async (req, res) => {
  try {
    const {
      originalMediaId,
      originalPublishedRecordId,
      hook,
      caption,
      hashtags,
      cta,
      publishTime,
      videoUrl
    } = req.body || {};

    if (!originalMediaId) {
      return res.status(400).json({ ok: false, error: "originalMediaId required" });
    }

    // Determine version number
    const rows = await querySqlite(
      `SELECT MAX(optimization_version) as max_ver FROM instagram_publish_queue 
       WHERE original_media_id = ? OR original_published_record_id = ?`,
      [originalMediaId, originalPublishedRecordId || originalMediaId]
    );
    const prevVer = Number(rows?.[0]?.max_ver || 1);
    const nextVer = prevVer + 1;

    const queueId = `ig_republish_${originalMediaId}_${Date.now()}`;
    const productionId = `republish_${originalMediaId}`;
    const pTime = publishTime || new Date(Date.now() + 15 * 60 * 1000).toISOString();

    // Resolve videoUrl if missing
    let resolvedVideoUrl = videoUrl || null;
    if (!resolvedVideoUrl) {
      const cache = loadPublishedAICache();
      if (cache[originalMediaId]?.mediaUrl) {
        resolvedVideoUrl = cache[originalMediaId].mediaUrl;
      }
    }
    if (!resolvedVideoUrl) {
      try {
        const qRows = await querySqlite(
          `SELECT video_url FROM instagram_publish_queue WHERE instagram_media_id = ? OR id = ? LIMIT 1`,
          [originalMediaId, originalMediaId]
        );
        if (qRows?.[0]?.video_url) resolvedVideoUrl = qRows[0].video_url;
      } catch (_) {}
    }
    if (!resolvedVideoUrl) {
      try {
        const igPublisher = require("../integrations/instagram/publisher");
        const live = await igPublisher.getPublishedMedia(30);
        const match = live.find(m => String(m.id) === String(originalMediaId));
        if (match?.media_url) resolvedVideoUrl = match.media_url;
      } catch (_) {}
    }

    // Strictly normalize hashtags to 5-10 niche tags
    const normalizedHashtags = normalizeInstagramHashtags(hashtags, {
      caption: typeof caption === "string" ? caption : "",
      topic: hook
    });

    let fullCaption = (caption || "").trim();
    if (cta && !fullCaption.toLowerCase().includes(cta.toLowerCase())) {
      fullCaption += `\n\n${cta}`;
    }
    const tagsStr = normalizedHashtags.join(" ");
    if (tagsStr && !fullCaption.includes(normalizedHashtags[0])) {
      fullCaption += `\n\n${tagsStr}`;
    }

    const title = (hook || `Repurposed Reel v${nextVer}`).slice(0, 100);

    // Insert into productions if not exists
    await runSqlite(
      `INSERT OR IGNORE INTO productions (id, status, scheduled_publish_time, priority) VALUES (?, 'approved', ?, 50)`,
      [productionId, pTime]
    );

    // Insert new version into instagram_publish_queue
    const instagramQueue = require("../integrations/instagram/queue");
    await instagramQueue.addToQueue({
      id: queueId,
      productionId,
      title,
      publishTime: pTime,
      priority: 45,
      videoUrl: resolvedVideoUrl,
      caption: fullCaption.trim(),
      originalMediaId,
      originalPublishedRecordId: originalPublishedRecordId || originalMediaId,
      optimizationVersion: nextVer
    });

    // Save relation into published cache
    const cache = loadPublishedAICache();
    if (!cache[originalMediaId]) cache[originalMediaId] = {};
    if (!Array.isArray(cache[originalMediaId].republishedVersions)) {
      cache[originalMediaId].republishedVersions = [];
    }
    cache[originalMediaId].republishedVersions.push({
      queueId,
      version: nextVer,
      title,
      publishTime: pTime,
      status: "ready",
      createdAt: new Date().toISOString()
    });
    if (resolvedVideoUrl && !cache[originalMediaId].mediaUrl) {
      cache[originalMediaId].mediaUrl = resolvedVideoUrl;
    }
    savePublishedAICache(cache);

    res.json({
      ok: true,
      queueId,
      version: nextVer,
      lifecycleState: "READY",
      title,
      caption: fullCaption.trim(),
      hashtags: normalizedHashtags,
      originalMediaId,
      originalPublishedRecordId: originalPublishedRecordId || originalMediaId,
      message: `Repurposed version v${nextVer} successfully created and ready in queue`
    });
  } catch (e) {
    console.error("[vidiq republish-version]", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.get("/api/instagram/published-comparison", async (req, res) => {
  try {
    const cache = loadPublishedAICache();
    const audits = Object.values(cache);

    let totalLikes = 0;
    let totalComments = 0;
    const hashtagMap = {};
    const strengths = [];
    const weaknesses = [];

    for (const a of audits) {
      const m = a.metrics || {};
      totalLikes += Number(m.like_count || 0);
      totalComments += Number(m.comments_count || 0);

      const tags = (m.caption || "").match(/#[a-zA-Z0-9_]+/g) || [];
      for (const t of tags) {
        const k = t.toLowerCase();
        hashtagMap[k] = (hashtagMap[k] || 0) + 1;
      }

      if (a.diagnosis?.strengths) strengths.push(...a.diagnosis.strengths);
      if (a.diagnosis?.weaknesses) weaknesses.push(...a.diagnosis.weaknesses);
    }

    const count = audits.length;
    const avgLikes = count ? Math.round(totalLikes / count) : 0;
    const avgComments = count ? Math.round(totalComments / count) : 0;

    const topHashtags = Object.entries(hashtagMap)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([tag, freq]) => ({ tag, frequency: freq }));

    res.json({
      ok: true,
      auditedReelsCount: count,
      benchmark: {
        averageLikes: avgLikes,
        averageComments: avgComments
      },
      topHashtags,
      commonStrengths: [...new Set(strengths)].slice(0, 5),
      commonWeaknesses: [...new Set(weaknesses)].slice(0, 5)
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

function querySqlite(sql, params = []) {
  return new Promise((resolve) => {
    try {
      const sqlite3 = require("sqlite3").verbose();
      const dbPath = path.join(process.cwd(), "data/youtube_automation.db");
      if (!fs.existsSync(dbPath)) return resolve([]);
      const db = new sqlite3.Database(dbPath, (err) => {
        if (err) return resolve([]);
      });
      db.all(sql, params, (err, rows) => {
        db.close();
        if (err) return resolve([]);
        resolve(rows || []);
      });
    } catch (_) {
      resolve([]);
    }
  });
}

function runSqlite(sql, params = []) {
  return new Promise((resolve, reject) => {
    try {
      const sqlite3 = require("sqlite3").verbose();
      const dbPath = path.join(process.cwd(), "data/youtube_automation.db");
      if (!fs.existsSync(dbPath)) return resolve({ changes: 0 });
      const db = new sqlite3.Database(dbPath, (err) => {
        if (err) return reject(err);
      });
      db.run(sql, params, function (err) {
        db.close();
        if (err) return reject(err);
        resolve({ changes: this.changes, lastID: this.lastID });
      });
    } catch (e) {
      reject(e);
    }
  });
}

function normalizeLifecycleState(status) {
  const s = String(status || "").toLowerCase();
  if (s === "scheduled") return "SCHEDULED";
  if (s === "processing" || s === "publishing") return "PUBLISHING";
  if (s === "published") return "PUBLISHED";
  if (s === "failed") return "FAILED";
  if (s === "skipped") return "SKIPPED";
  return "PENDING";
}

router.get("/api/queue/all", async (req, res) => {
  try {
    const ytRows = await querySqlite(
      `SELECT id, production_id, title, publish_time, status, priority, metadata, youtube_id, youtube_url, published_at, error_message, created_at
       FROM publish_schedule
       ORDER BY publish_time DESC, created_at DESC
       LIMIT 60`
    );

    const igRows = await querySqlite(
      `SELECT id, production_id, title, publish_time, status, priority, video_url, caption, container_id, instagram_media_id, published_at, error_message, retry_count, created_at,
              original_media_id, original_published_record_id, optimization_version
       FROM instagram_publish_queue
       ORDER BY publish_time DESC, created_at DESC
       LIMIT 60`
    );

    const youtube = ytRows.map((r) => {
      let meta = {};
      try { meta = JSON.parse(r.metadata || '{}'); } catch (_) {}
      const seo = meta.seo || {};
      const filename = meta.video?.path ? path.basename(meta.video.path) : (r.production_id ? `${r.production_id}-ready.mp4` : null);
      return {
        id: r.id,
        productionId: r.production_id,
        title: r.title || seo.title || "Untitled YouTube Video",
        description: seo.description || meta.description || "",
        tags: Array.isArray(seo.tags) ? seo.tags : (Array.isArray(meta.tags) ? meta.tags : []),
        hashtags: Array.isArray(seo.hashtags) ? seo.hashtags : (Array.isArray(meta.hashtags) ? meta.hashtags : []),
        videoUrl: filename ? `/vidiq/api/media/${encodeURIComponent(filename)}` : null,
        filename,
        publishTime: r.publish_time,
        publishedAt: r.published_at,
        status: r.status,
        lifecycleState: normalizeLifecycleState(r.status),
        platform: "youtube",
        youtubeId: r.youtube_id,
        youtubeUrl: r.youtube_url,
        errorMessage: r.error_message,
        createdAt: r.created_at
      };
    });

    const { getVideoResolution } = require("../utils/ffmpeg");
    if (!globalThis.__vidiqVideoResolutionCache) globalThis.__vidiqVideoResolutionCache = new Map();
    const resCache = globalThis.__vidiqVideoResolutionCache;

    const instagram = await Promise.all(igRows.map(async (r) => {
      let width = null;
      let height = null;
      let resolution = "Resolution: Unknown";

      const candidates = [
        path.resolve("content/processing", `${r.production_id}-ready.mp4`),
        path.resolve("content/processing", `${r.production_id}.mp4`),
        r.video_url ? path.resolve("content/processing", path.basename(r.video_url)) : null,
        r.video_url ? path.resolve("content", path.basename(r.video_url)) : null,
        r.video_url ? path.resolve("content/inbox", path.basename(r.video_url)) : null
      ].filter(Boolean);

      const foundPath = candidates.find(p => fs.existsSync(p));
      const filename = foundPath ? path.basename(foundPath) : null;
      const videoUrl = filename ? `/vidiq/api/media/${encodeURIComponent(filename)}` : r.video_url;

      if (resCache.has(r.id)) {
        const cached = resCache.get(r.id);
        width = cached.width;
        height = cached.height;
      } else if (foundPath) {
        try {
          const dims = await getVideoResolution(foundPath);
          if (dims && dims.width && dims.height) {
            width = dims.width;
            height = dims.height;
            resCache.set(r.id, { width, height });
          }
        } catch (_) {}
      }

      if (width && height) {
        const ratio = width / height;
        const ratioStr = (Math.abs(ratio - 9/16) < 0.08 || (width === 1080 && height === 1920) || (width === 720 && height === 1280))
          ? "9:16"
          : (ratio > 1 ? "16:9" : (Math.abs(ratio - 1) < 0.05 ? "1:1" : `${Math.round(ratio*100)/100}:1`));
        const orient = height >= width ? "Vertical" : "Horizontal";
        resolution = `${width} × ${height} · ${ratioStr} · ${orient}`;
      }

      const hashtags = (r.caption && r.caption.match(/#\w+/g)) || [];
      const cleanCaption = r.caption ? r.caption.replace(/#\w+/g, '').trim() : '';

      return {
        id: r.id,
        productionId: r.production_id,
        title: r.title || (cleanCaption ? cleanCaption.slice(0, 60) : "Instagram Reel"),
        publishTime: r.publish_time,
        publishedAt: r.published_at,
        status: r.status,
        lifecycleState: normalizeLifecycleState(r.status),
        platform: "instagram",
        caption: cleanCaption || r.caption,
        hashtags,
        videoUrl,
        filename,
        mediaId: r.instagram_media_id,
        retryCount: r.retry_count || 0,
        errorMessage: r.error_message,
        createdAt: r.created_at,
        originalMediaId: r.original_media_id || null,
        originalPublishedRecordId: r.original_published_record_id || null,
        optimizationVersion: r.optimization_version || 1,
        width,
        height,
        resolution
      };
    }));

    const allItems = [...youtube, ...instagram].sort((a, b) => {
      const ta = new Date(a.publishTime || a.createdAt || 0).getTime();
      const tb = new Date(b.publishTime || b.createdAt || 0).getTime();
      return tb - ta;
    });

    const summary = {
      total: allItems.length,
      scheduled: allItems.filter((i) => i.lifecycleState === "SCHEDULED").length,
      publishing: allItems.filter((i) => i.lifecycleState === "PUBLISHING").length,
      published: allItems.filter((i) => i.lifecycleState === "PUBLISHED").length,
      failed: allItems.filter((i) => i.lifecycleState === "FAILED").length,
      skipped: allItems.filter((i) => i.lifecycleState === "SKIPPED").length
    };

    res.json({
      ok: true,
      items: allItems,
      youtube,
      instagram,
      summary
    });
  } catch (e) {
    console.error("[vidiq queue/all]", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post("/api/queue/:platform/:id/update", async (req, res) => {
  try {
    const { platform, id } = req.params;
    const { title, caption, hashtags, cta, status } = req.body || {};
    if (platform === "instagram") {
      let fullCaption = caption || "";
      const tagsStr = Array.isArray(hashtags) ? hashtags.join(" ") : (hashtags || "");
      if (tagsStr) {
        const clean = fullCaption.replace(/#\w+/g, '').trim();
        fullCaption = clean ? `${clean}\n\n${tagsStr}` : tagsStr;
      }
      if (cta && !fullCaption.includes(cta)) {
        fullCaption += `\n\n${cta}`;
      }
      await runSqlite(
        `UPDATE instagram_publish_queue
         SET title = COALESCE(?, title),
             caption = COALESCE(?, caption),
             status = COALESCE(?, status),
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [title || null, fullCaption.trim() || null, status || null, id]
      );
      return res.json({ ok: true, message: "Instagram item updated" });
    } else if (platform === "youtube") {
      const { description, hashtags, tags } = req.body || {};
      const rows = await querySqlite(`SELECT metadata, title FROM publish_schedule WHERE id = ?`, [id]);
      let meta = {};
      if (rows.length && rows[0].metadata) {
        try { meta = JSON.parse(rows[0].metadata); } catch (_) {}
      }
      meta.seo = meta.seo || {};
      if (title !== undefined) { meta.seo.title = title; }
      if (description !== undefined) { meta.seo.description = description; }
      if (tags !== undefined) {
        meta.seo.tags = Array.isArray(tags) ? tags : String(tags).split(',').map(s => s.trim()).filter(Boolean);
      }
      if (hashtags !== undefined) {
        meta.seo.hashtags = Array.isArray(hashtags) ? hashtags : String(hashtags).split(/\s+/).map(s => s.trim()).filter(Boolean);
      }
      await runSqlite(
        `UPDATE publish_schedule
         SET title = COALESCE(?, title),
             metadata = ?,
             status = COALESCE(?, status)
         WHERE id = ?`,
        [title || null, JSON.stringify(meta), status || null, id]
      );
      return res.json({ ok: true, message: "YouTube item updated" });
    }
    res.status(400).json({ ok: false, error: "Invalid platform" });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post("/api/queue/:platform/:id/retry", async (req, res) => {
  try {
    const { platform, id } = req.params;
    if (platform === "instagram") {
      await runSqlite(
        `UPDATE instagram_publish_queue
         SET status = 'scheduled',
             retry_count = COALESCE(retry_count, 0) + 1,
             error_message = NULL,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [id]
      );
      return res.json({ ok: true, message: "Instagram item re-scheduled for publication" });
    } else if (platform === "youtube") {
      await runSqlite(
        `UPDATE publish_schedule
         SET status = 'scheduled',
             error_message = NULL
         WHERE id = ?`,
        [id]
      );
      return res.json({ ok: true, message: "YouTube item re-scheduled for publication" });
    }
    res.status(400).json({ ok: false, error: "Invalid platform" });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post("/api/queue/:platform/:id/cancel", async (req, res) => {
  try {
    const { platform, id } = req.params;
    if (platform === "instagram") {
      await runSqlite(
        `UPDATE instagram_publish_queue
         SET status = 'skipped',
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [id]
      );
      return res.json({ ok: true, message: "Instagram queue item marked skipped" });
    } else if (platform === "youtube") {
      await runSqlite(
        `UPDATE publish_schedule
         SET status = 'skipped'
         WHERE id = ?`,
        [id]
      );
      return res.json({ ok: true, message: "YouTube schedule item marked skipped" });
    }
    res.status(400).json({ ok: false, error: "Invalid platform" });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post("/api/queue/:platform/:id/publish-now", async (req, res) => {
  try {
    const { platform, id } = req.params;
    if (platform === "instagram") {
      await runSqlite(
        `UPDATE instagram_publish_queue
         SET publish_time = datetime('now', '-1 minute'),
             status = 'scheduled',
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [id]
      );
      try {
        const InstagramWorker = require("../integrations/instagram/worker");
        const worker = new InstagramWorker();
        worker.processDuePosts().catch((err) => console.error("[publish-now ig error]", err));
      } catch (err) {
        console.warn("[publish-now ig trigger]", err.message);
      }
      return res.json({ ok: true, message: "Instagram reel scheduled for immediate publication" });
    } else if (platform === "youtube") {
      await runSqlite(
        `UPDATE publish_schedule
         SET publish_time = datetime('now', '-1 minute'),
             status = 'scheduled'
         WHERE id = ?`,
        [id]
      );
      return res.json({ ok: true, message: "YouTube video scheduled for immediate publication" });
    }
    res.status(400).json({ ok: false, error: "Invalid platform" });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post("/api/queue/:platform/:id/regenerate-seo", async (req, res) => {
  try {
    const { platform, id } = req.params;
    const { processSharedVideoMetadata } = require("../utils/shared-metadata-pipeline");

    if (platform === "instagram") {
      const rows = await querySqlite(`SELECT * FROM instagram_publish_queue WHERE id = ?`, [id]);
      if (!rows.length) return res.status(404).json({ ok: false, error: "Reel not found" });
      const item = rows[0];

      const candidates = [
        path.resolve("content/processing", `${item.production_id}-ready.mp4`),
        path.resolve("content/processing", `${item.production_id}.mp4`),
        item.video_url ? path.resolve("content/processing", path.basename(item.video_url)) : null,
        item.video_url ? path.resolve("content", path.basename(item.video_url)) : null,
        item.video_url ? path.resolve("content/inbox", path.basename(item.video_url)) : null
      ].filter(Boolean);
      const foundPath = candidates.find((p) => fs.existsSync(p)) || (item.video_url && fs.existsSync(item.video_url) ? item.video_url : null);

      if (!foundPath) {
        return res.status(400).json({ ok: false, error: "Source video file not found on disk" });
      }

      const meta = await processSharedVideoMetadata(foundPath, { force: true });
      const igMeta = meta.instagram || {};

      await runSqlite(
        `UPDATE instagram_publish_queue
         SET title = ?,
             caption = ?,
             metadata_status = 'ready',
             seo_data_json = ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [igMeta.title || item.title, igMeta.caption || item.caption, JSON.stringify(igMeta), id]
      );

      return res.json({ ok: true, metadata: igMeta, message: "Instagram SEO regenerated successfully" });
    } else if (platform === "youtube") {
      const rows = await querySqlite(`SELECT * FROM publish_schedule WHERE id = ?`, [id]);
      if (!rows.length) return res.status(404).json({ ok: false, error: "YouTube item not found" });
      const item = rows[0];

      const candidates = [
        path.resolve("content/processing", `${item.production_id}-ready.mp4`),
        path.resolve("content/processing", `${item.production_id}.mp4`),
        path.resolve("content/inbox", `${item.production_id}.mp4`)
      ];
      const foundPath = candidates.find((p) => fs.existsSync(p));
      if (!foundPath) {
        return res.status(400).json({ ok: false, error: "Source video file not found on disk" });
      }

      const meta = await processSharedVideoMetadata(foundPath, { force: true });
      const ytMeta = meta.youtube || {};

      await runSqlite(
        `UPDATE publish_schedule
         SET title = ?,
             metadata = ?
         WHERE id = ?`,
        [ytMeta.title || item.title, JSON.stringify(ytMeta), id]
      );

      return res.json({ ok: true, metadata: ytMeta, message: "YouTube SEO regenerated successfully" });
    }
    res.status(400).json({ ok: false, error: "Invalid platform" });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.get("/api/instagram/reels-list", async (req, res) => {
  try {
    const igRows = await querySqlite(
      `SELECT id, production_id, title, publish_time, status, priority, video_url, caption, container_id,
              instagram_media_id, published_at, error_message, retry_count, content_hash,
              metadata_status, seo_data_json, created_at, updated_at
       FROM instagram_publish_queue
       ORDER BY publish_time DESC, created_at DESC
       LIMIT 100`
    );

    const reels = igRows.map((r) => {
      let badgeStatus = "READY";
      const s = String(r.status || "").toLowerCase();
      const err = String(r.error_message || "").toLowerCase();
      if (s === "published") {
        badgeStatus = "PUBLISHED";
      } else if (s === "skipped" || err.includes("duplicate")) {
        badgeStatus = "SKIPPED DUPLICATE";
      } else if (s === "failed") {
        badgeStatus = "FAILED";
      } else if (s === "scheduled") {
        badgeStatus = "SCHEDULED";
      } else if (r.metadata_status === "ready" || (r.caption && r.caption.trim().length > 10)) {
        badgeStatus = "SEO READY";
      } else {
        badgeStatus = "READY";
      }

      const tags = (r.caption || "").match(/#[a-zA-Z0-9_]+/g) || [];
      let livePostUrl = null;
      if (r.instagram_media_id) {
        livePostUrl = `https://www.instagram.com/p/${r.instagram_media_id}/`;
      }

      return {
        id: r.id,
        productionId: r.production_id,
        title: r.title || (r.caption ? r.caption.slice(0, 60) : "Instagram Reel"),
        caption: r.caption || "",
        hashtags: tags,
        status: r.status,
        badgeStatus,
        publishTime: r.publish_time,
        publishedAt: r.published_at,
        videoUrl: r.video_url,
        mediaId: r.instagram_media_id,
        livePostUrl,
        errorMessage: r.error_message,
        retryCount: r.retry_count || 0,
        contentHash: r.content_hash,
        createdAt: r.created_at,
        updatedAt: r.updated_at
      };
    });

    res.json({
      ok: true,
      reels,
      total: reels.length,
      counts: {
        ready: reels.filter((r) => r.badgeStatus === "READY").length,
        seoReady: reels.filter((r) => r.badgeStatus === "SEO READY").length,
        scheduled: reels.filter((r) => r.badgeStatus === "SCHEDULED").length,
        published: reels.filter((r) => r.badgeStatus === "PUBLISHED").length,
        skippedDuplicate: reels.filter((r) => r.badgeStatus === "SKIPPED DUPLICATE").length,
        failed: reels.filter((r) => r.badgeStatus === "FAILED").length
      }
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.get("/api/inbox", async (req, res) => {
  try {
    const inboxDir = path.join(process.cwd(), "content/inbox");
    if (!fs.existsSync(inboxDir)) {
      return res.json({ ok: true, files: [] });
    }

    const entries = fs.readdirSync(inboxDir);
    const videoExts = [".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v"];
    const files = [];

    const videoCache = loadVideoAICache();

    for (const name of entries) {
      if (name.startsWith(".")) continue;
      const fullPath = path.join(inboxDir, name);
      try {
        const stat = fs.statSync(fullPath);
        if (!stat.isFile()) continue;
        const ext = path.extname(name).toLowerCase();
        if (!videoExts.includes(ext)) continue;

        const baseNameNoExt = path.basename(name, ext);
        const hasYtAudit = Boolean(videoCache[baseNameNoExt]?.seo || videoCache[name]?.seo || videoCache[baseNameNoExt]?.understanding);
        const hasIgAudit = Boolean(videoCache[baseNameNoExt]?.instagram || videoCache[name]?.instagram);

        files.push({
          name,
          path: fullPath,
          sizeBytes: stat.size,
          sizeMB: (stat.size / (1024 * 1024)).toFixed(1),
          modifiedAt: stat.mtime.toISOString(),
          extension: ext,
          hasYtAudit,
          hasIgAudit
        });
      } catch (_) {}
    }

    files.sort((a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime());
    res.json({ ok: true, items: files, files, count: files.length });
  } catch (e) {
    console.error("[vidiq inbox]", e);
    res.status(500).json({ ok: false, error: e.message, items: [], files: [], count: 0 });
  }
});

router.get("/api/instagram/auth-status", async (req, res) => {
  try {
    const igPublisher = require("../integrations/instagram/publisher");
    const status = await igPublisher.checkAuthStatus();
    res.json({
      ok: true,
      authenticated: Boolean(status?.authenticated),
      username: status?.username || null,
      userId: status?.userId || null,
      status
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post("/api/instagram/refresh-token", async (req, res) => {
  try {
    const igPublisher = require("../integrations/instagram/publisher");
    const config = igPublisher.loadConfig();
    const result = await igPublisher.attemptTokenRefresh(config.access_token);
    res.json({ ok: result.success, result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post("/api/instagram/update-token", async (req, res) => {
  try {
    const { token } = req.body || {};
    if (!token || typeof token !== "string") {
      return res.status(400).json({ ok: false, error: "Valid access token string is required" });
    }
    const igPublisher = require("../integrations/instagram/publisher");
    const result = await igPublisher.saveNewToken(token);
    res.json({ ok: true, message: "Instagram credentials updated successfully", result });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

router.get("/api/instagram/oauth/url", (req, res) => {
  try {
    const igPublisher = require("../integrations/instagram/publisher");
    const redirectUri = req.query.redirect_uri || `${req.protocol}://${req.get('host')}/vidiq/api/instagram/oauth/callback`;
    const url = igPublisher.getOAuthAuthorizationUrl(redirectUri);
    res.json({ ok: true, url, redirectUri });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

router.get("/api/instagram/oauth/callback", async (req, res) => {
  try {
    const { code, error, error_description } = req.query || {};
    if (error) {
      return res.status(400).send(`<h1>Instagram Authorization Failed</h1><p>${error_description || error}</p>`);
    }
    if (!code) {
      return res.status(400).send(`<h1>Missing Authorization Code</h1><p>No code received from Meta.</p>`);
    }

    const igPublisher = require("../integrations/instagram/publisher");
    const redirectUri = `${req.protocol}://${req.get('host')}/vidiq/api/instagram/oauth/callback`;
    const result = await igPublisher.exchangeAuthCodeForLongLivedToken(code, redirectUri);

    res.send(`<!DOCTYPE html>
<html>
<head><title>Instagram Authorization Succeeded</title></head>
<body style="font-family: sans-serif; text-align: center; padding: 40px; background: #0f172a; color: #f8fafc;">
  <div style="max-width: 500px; margin: 0 auto; background: #1e293b; padding: 30px; border-radius: 12px; border: 1px solid #334155;">
    <h1 style="color: #4ade80;">Instagram Connected!</h1>
    <p>User ID: <strong>${result.userId}</strong></p>
    ${result.username ? `<p>Account: <strong>@${result.username}</strong></p>` : ''}
    <p style="color: #94a3b8;">Long-lived access token configured and active for 60 days. You can safely close this window.</p>
  </div>
</body>
</html>`);
  } catch (e) {
    res.status(500).send(`<h1>Instagram Token Exchange Failed</h1><p>${e.message}</p>`);
  }
});

router.post("/api/instagram/update-app-credentials", (req, res) => {
  try {
    const { appId, appSecret } = req.body || {};
    const igPublisher = require("../integrations/instagram/publisher");
    const result = igPublisher.updateAppCredentials({ appId, appSecret });
    res.json({ ok: true, message: "App credentials updated successfully", result });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

router.get("/api/test/openrouter-multimodal", async (req, res) => {
  try {
    const { extractRepresentativeFrames, parseVisualAnalysisJson } = require("../utils/video-understanding");
    const { AITextService } = require("../utils/ai-text-service");
    const testVideoPath = path.resolve("content/processing/inbox_39eb8d68d91ad066-ready.mp4");
    if (!fs.existsSync(testVideoPath)) {
      return res.status(404).json({ ok: false, error: "Test video not found on disk" });
    }
    const { duration, timestamps, frames } = await extractRepresentativeFrames(testVideoPath, {
      contentHash: "test_" + Date.now(),
      logger: console
    });
    const key = process.env.OPENROUTER_API_KEY;
    if (!key) return res.status(500).json({ ok: false, error: "OPENROUTER_API_KEY not configured" });
    const aiService = new AITextService({
      provider: "openrouter",
      apiKey: key,
      openRouterModel: "google/gemini-2.0-flash-001"
    });
    const promptText = `Analyze these ${frames.length} representative sequential frames extracted from a real video across its ${duration.toFixed(1)}s timeline. Return ONLY valid JSON with keys: visual_keywords, main_subject, objects, materials, tools, actions, process, transformation, final_result, environment, visible_text, category, summary, confidence.`;
    const parts = [
      ...frames.map(f => ({ inlineData: { mimeType: "image/jpeg", data: f.base64 } })),
      { text: promptText }
    ];
    const rawResponse = await aiService.generateMultimodalContent(parts, { maxTokens: 750, temperature: 0.2 });
    const analysis = parseVisualAnalysisJson(rawResponse, console);
    res.json({
      ok: true,
      video: path.basename(testVideoPath),
      duration,
      framesExtracted: frames.length,
      timestamps,
      analysis,
      safety: "Non-publishing test; publishing queue & database completely untouched"
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.get("/api/system-status", async (req, res) => {
  try {
    const credPath = path.join(process.cwd(), "config/credentials.json");
    const tokPath = path.join(process.cwd(), "config/tokens.json");
    const igPath = path.join(process.cwd(), "config/instagram.json");
    const dbPath = path.join(process.cwd(), "data/youtube_automation.db");

    const hasYtCreds = fs.existsSync(credPath);
    const hasYtTokens = fs.existsSync(tokPath);
    const hasIgConfig = fs.existsSync(igPath);
    const hasDb = fs.existsSync(dbPath);

    let igUser = null;
    if (hasIgConfig) {
      try {
        const igData = JSON.parse(fs.readFileSync(igPath, "utf-8"));
        igUser = igData.ig_user_id || null;
      } catch (_) {}
    }

    const openRouterConfigured = Boolean(process.env.OPENROUTER_API_KEY);

    res.json({
      ok: true,
      mainEngine: "active",
      api: "running",
      youtube: {
        configured: hasYtCreds && hasYtTokens,
        credentials: hasYtCreds,
        tokens: hasYtTokens
      },
      instagram: {
        configured: hasIgConfig && Boolean(igUser),
        userId: igUser
      },
      ai: {
        openRouterConfigured,
        fallbackModels: OPENROUTER_FALLBACK_MODELS
      },
      database: {
        connected: hasDb,
        path: "data/youtube_automation.db"
      },
      queue: {
        available: true
      },
      timestamp: new Date().toISOString()
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.get(["/api/overview", "/api/queue/overview"], async (req, res) => {
  try {
    // 1. YouTube Stats
    let ytStats = { title: "YouTube Channel", subscribers: 0, views: 0, videos: 0 };
    try {
      const client = yt();
      const chRes = await client.channels.list({ part: ["snippet", "statistics"], mine: true });
      if (chRes.data.items && chRes.data.items[0]) {
        const ch = chRes.data.items[0];
        ytStats = {
          title: ch.snippet.title,
          subscribers: Number(ch.statistics.subscriberCount || 0),
          views: Number(ch.statistics.viewCount || 0),
          videos: Number(ch.statistics.videoCount || 0)
        };
      }
    } catch (_) {}

    // 2. Daily Quota Metrics from schedule calculator
    const { getDailyQuotaMetrics } = require("../utils/schedule-calculator");
    const dbAdapter = {
      getSetting: async (k) => {
        const rows = await querySqlite('SELECT value FROM settings WHERE key = ?', [k]);
        return rows[0]?.value;
      },
      getRow: async (sql, params = []) => {
        const rows = await querySqlite(sql, params);
        return rows[0] || null;
      },
      getAllRows: async (sql, params = []) => {
        return await querySqlite(sql, params);
      }
    };
    const quotas = await getDailyQuotaMetrics(dbAdapter).catch(() => null);

    // 3. Queue Summary
    const ytCount = await querySqlite(`SELECT count(*) as count, status FROM publish_schedule GROUP BY status`);
    const igCount = await querySqlite(`SELECT count(*) as count, status FROM instagram_publish_queue GROUP BY status`);

    let scheduledCount = 0;
    let publishedCount = 0;
    let failedCount = 0;
    let skippedCount = 0;

    for (const r of [...ytCount, ...igCount]) {
      const s = String(r.status || "").toLowerCase();
      if (s === "scheduled") scheduledCount += Number(r.count || 0);
      else if (s === "published") publishedCount += Number(r.count || 0);
      else if (s === "failed") failedCount += Number(r.count || 0);
      else if (s === "skipped") skippedCount += Number(r.count || 0);
    }

    // 4. Inbox Count & Ready Counts
    let inboxCount = 0;
    try {
      const inboxDir = path.join(process.cwd(), "content/inbox");
      if (fs.existsSync(inboxDir)) {
        inboxCount = fs.readdirSync(inboxDir).filter((f) => !f.startsWith(".")).length;
      }
    } catch (_) {}

    const igReadyRows = await querySqlite(`SELECT count(*) as count FROM instagram_publish_queue WHERE status IN ('ready', 'draft', 'pending')`);
    const ytReadyRows = await querySqlite(`SELECT count(*) as count FROM publish_schedule WHERE status IN ('ready', 'draft', 'pending')`);
    const igReadyCount = Number(igReadyRows[0]?.count || 0) + inboxCount;
    const ytReadyCount = Number(ytReadyRows[0]?.count || 0) + inboxCount;

    // 5. Recent successful posts
    const recentSuccessful = await querySqlite(
      `SELECT 'youtube' as platform, id, title, published_at, youtube_url as url
       FROM publish_schedule WHERE status = 'published'
       UNION ALL
       SELECT 'instagram' as platform, id, title, published_at, COALESCE(video_url, instagram_media_id) as url
       FROM instagram_publish_queue WHERE status = 'published'
       ORDER BY published_at DESC LIMIT 10`
    ).catch(() => []);

    // 6. Duplicate / skipped items
    const skippedItems = await querySqlite(
      `SELECT 'youtube' as platform, id, title, publish_time, error_message, updated_at
       FROM publish_schedule WHERE status = 'skipped'
       UNION ALL
       SELECT 'instagram' as platform, id, title, publish_time, error_message, updated_at
       FROM instagram_publish_queue WHERE status = 'skipped'
       ORDER BY updated_at DESC LIMIT 10`
    ).catch(() => []);

    // 7. Failed items requiring attention
    const failedItems = await querySqlite(
      `SELECT 'youtube' as platform, id, title, publish_time, error_message, updated_at
       FROM publish_schedule WHERE status = 'failed'
       UNION ALL
       SELECT 'instagram' as platform, id, title, publish_time, error_message, updated_at
       FROM instagram_publish_queue WHERE status = 'failed'
       ORDER BY updated_at DESC LIMIT 10`
    ).catch(() => []);

    // 8. Instagram Mode 2 published cache count
    const igPubCache = loadPublishedAICache();
    const auditedReelsCount = Object.keys(igPubCache).length;

    res.json({
      ok: true,
      youtube: ytStats,
      quotas: quotas || {
        instagram: { dailyTarget: 10, scheduledToday: 0, publishedToday: 0, remainingToday: 10, nextScheduled: null },
        youtube: { dailyTarget: 6, scheduledToday: 0, publishedToday: 0, remainingToday: 6, nextScheduled: null }
      },
      ready: {
        instagram: igReadyCount,
        youtube: ytReadyCount,
        inbox: inboxCount
      },
      queues: {
        scheduled: scheduledCount,
        published: publishedCount,
        failed: failedCount,
        skipped: skippedCount
      },
      recentSuccessful,
      skippedItems,
      failedItems,
      inboxCount,
      auditedReelsCount
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post("/api/ask", async (req, res) => {
  try {
    const q = req.body?.question || "";
    if (!q.trim()) return res.status(400).json({ ok: false, error: "Question is required" });
    const answer = await ai(q, "You are an expert YouTube and Instagram growth coach. Provide concise, high-impact tactical advice.");
    res.json({ ok: true, answer: answer || "No response generated" });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Safe API-only JSON 404 handler: Any unmatched /api/* request under /vidiq returns JSON, NEVER HTML
router.all("/api/*", (req, res) => {
  res.status(404).json({
    ok: false,
    error: `API route not found: ${req.method} /vidiq${req.path}`
  });
});

// SPA fallback for normal dashboard pages under /vidiq
router.get(["/", "/dashboard", "/dashboard.html", "*"], (req, res) => {
  res.sendFile(path.join(process.cwd(), "dashboard/vidiq.html"));
});

module.exports=router;
