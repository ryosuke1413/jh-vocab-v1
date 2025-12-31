
const $ = (id) => document.getElementById(id);

const els = {
  setup: $("setup"),
  quiz: $("quiz"),
  result: $("result"),

  userName: $("userName"),
  saveUserBtn: $("saveUserBtn"),

  level: $("level"),
  quizType: $("quizType"),
  direction: $("direction"),
  directionHint: $("directionHint"),

  startBtn: $("startBtn"),
  reviewBtn: $("reviewBtn"),
  resetBtn: $("resetBtn"),

  rankChip: $("rankChip"),
  rankName: $("rankName"),
  rankRemain: $("rankRemain"),
  barFill: $("barFill"),

  totalOk: $("totalOk"),
  totalAns: $("totalAns"),
  acc: $("acc"),
  missCnt: $("missCnt"),

  rankDetails: $("rankDetails"),
  rankList: $("rankList"),

  progress: $("progress"),
  qTypePill: $("qTypePill"),
  quitBtn: $("quitBtn"),

  qText: $("qText"),
  choices: $("choices"),

  typing: $("typing"),
  typeMeaning: $("typeMeaning"),
  typeExample: $("typeExample"),
  typeInput: $("typeInput"),
  checkBtn: $("checkBtn"),

  feedback: $("feedback"),
  nextBtn: $("nextBtn"),

  resultText: $("resultText"),
  backBtn: $("backBtn"),
  retryMissBtn: $("retryMissBtn"),
  missList: $("missList"),
};

const STORAGE_KEY = "jhse_vocab_v4";
const ROLLING_N = 50;
const MIN_HISTORY_FOR_RANK = 30;

// 昇降格（緩和）
const PROMOTE_ACC = 0.85;
const DEMOTE_ACC = 0.70;

// ランク（累計正解ベース + 正答率で±1）
const RANKS = [
  { key:"beginner",  name:"ビギナー",     needOk:   0, css:"rank-beginner" },
  { key:"iron",      name:"アイロン",     needOk:  30, css:"rank-iron" },
  { key:"bronze",    name:"ブロンズ",     needOk:  90, css:"rank-bronze" },
  { key:"silver",    name:"シルバー",     needOk: 180, css:"rank-silver" },
  { key:"gold",      name:"ゴールド",     needOk: 320, css:"rank-gold" },
  { key:"platinum",  name:"プラチナ",     needOk: 520, css:"rank-platinum" },
  { key:"diamond",   name:"ダイヤモンド", needOk: 780, css:"rank-diamond" },
  { key:"master",    name:"マスター",     needOk:1100, css:"rank-master" },
];

let WORDS = [];
let state = null;
let session = null;

function defaultState(){
  return {
    userName: "",
    totalAns: 0,
    totalOk: 0,
    rolling: [], // boolean[] newest last
    miss: {},     // key -> {en,ja,level,series,forms?, misses}
    lastConfig: { level: 1, quizType:"mc", direction:"en_to_ja" },
  };
}
function loadState(){
  try{
    const raw = localStorage.getItem(STORAGE_KEY);
    if(!raw) return defaultState();
    const s = JSON.parse(raw);
    const d = defaultState();
    const out = { ...d, ...s, lastConfig: { ...d.lastConfig, ...(s.lastConfig||{}) } };
    if(!Array.isArray(out.rolling)) out.rolling = [];
    out.rolling = out.rolling.map(Boolean).slice(-ROLLING_N);
    if(!out.miss || typeof out.miss !== "object") out.miss = {};
    return out;
  }catch{
    return defaultState();
  }
}
function saveState(){
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}
function resetState(){
  localStorage.removeItem(STORAGE_KEY);
  state = defaultState();
  saveState();
  syncSetupUI();
  refreshStats();
  refreshRank();
  screen("setup");
}

function screen(name){
  els.setup.classList.toggle("hidden", name!=="setup");
  els.quiz.classList.toggle("hidden", name!=="quiz");
  els.result.classList.toggle("hidden", name!=="result");
}

function clamp(n,min,max){ return Math.max(min, Math.min(max,n)); }
function norm(s){ return String(s??"").trim().replace(/\s+/g," ").toLowerCase(); }
function shuffle(a){
  const arr = a.slice();
  for(let i=arr.length-1;i>0;i--){
    const j = Math.floor(Math.random()*(i+1));
    [arr[i],arr[j]]=[arr[j],arr[i]];
  }
  return arr;
}
function sample(arr){ return arr[Math.floor(Math.random()*arr.length)]; }
function keyOf(w){ return `${w.en}||${w.ja}`; }

function rollingAcc(){
  const r = state.rolling;
  if(r.length===0) return null;
  const ok = r.filter(Boolean).length;
  return ok / r.length;
}

// ---- Rank helpers ----
function baseRankIndexByOk(totalOk){
  let idx=0;
  for(let i=0;i<RANKS.length;i++){
    if(totalOk >= RANKS[i].needOk) idx=i;
  }
  return idx;
}
function rankDeltaByAccuracy(acc){
  if(acc===null) return 0;
  if(state.rolling.length < MIN_HISTORY_FOR_RANK) return 0;
  if(acc >= PROMOTE_ACC) return +1;
  if(acc < DEMOTE_ACC) return -1;
  return 0;
}
function effectiveRankIndex(){
  const base = baseRankIndexByOk(state.totalOk);
  const acc = rollingAcc();
  return clamp(base + rankDeltaByAccuracy(acc), 0, RANKS.length-1);
}
function refreshRank(){
  const eff = effectiveRankIndex();
  const base = baseRankIndexByOk(state.totalOk);
  const r = RANKS[eff];

  els.rankChip.className = `rankChip ${r.css}`;
  els.rankChip.textContent = r.name;
  els.rankName.textContent = r.name;

  const next = RANKS[Math.min(base+1, RANKS.length-1)];
  const remain = (base === RANKS.length-1) ? 0 : Math.max(0, next.needOk - state.totalOk);
  els.rankRemain.textContent = (base === RANKS.length-1) ? "MAX" : String(remain);

  const curNeed = RANKS[base].needOk;
  const nextNeed = next.needOk;
  const pct = (base === RANKS.length-1) ? 100 : ((state.totalOk - curNeed) / Math.max(1,(nextNeed-curNeed))) * 100;
  els.barFill.style.width = `${clamp(pct,0,100)}%`;

  // 推奨難易度：effectiverankを 1-3 に丸め
  const suggestedLevel = clamp(eff+1, 1, 3);
  if(String(els.level.value) === "" || !session){
    // setup中は提案として自動反映
    els.level.value = String(suggestedLevel);
  }
}

function refreshStats(){
  els.totalAns.textContent = String(state.totalAns);
  els.totalOk.textContent = String(state.totalOk);
  const acc = rollingAcc();
  els.acc.textContent = acc===null ? "0%" : `${Math.round(acc*100)}%`;
  els.missCnt.textContent = String(Object.keys(state.miss||{}).length);
}

function buildRankList(){
  if(!els.rankList) return;
  els.rankList.innerHTML = "";
  for(const r of RANKS){
    const div = document.createElement("div");
    div.className = "rankItem";
    div.innerHTML = `
      <div class="rankBadge ${r.css}">${r.name}</div>
      <div class="rankNeed muted">累計正解 ${r.needOk}+</div>
    `;
    els.rankList.appendChild(div);
  }
}

// ---- words.json loader ----
async function loadWords(){
  const res = await fetch("./words.json", { cache:"no-store" });
  if(!res.ok) throw new Error("words.json を読み込めませんでした");
  const data = await res.json();
  if(!Array.isArray(data)) throw new Error("words.json の形式が不正です（配列ではありません）");

  const cleaned = [];
  for(const w of data){
    if(!w || typeof w.en!=="string" || typeof w.ja!=="string") continue;
    const level = Number(w.level);
    if(!(level===1||level===2||level===3)) continue;
    const entry = { en:w.en, ja:w.ja, level, series: String(w.series||"その他") };
    if(w.forms && typeof w.forms.base==="string" && typeof w.forms.past==="string" && typeof w.forms.pp==="string"){
      entry.forms = { base:w.forms.base, past:w.forms.past, pp:w.forms.pp };
    }
    cleaned.push(entry);
  }
  return cleaned;
}

function levelLabel(lv){
  if(lv===1) return "レベル1（基礎）";
  if(lv===2) return "レベル2（標準）";
  return "レベル3（発展）";
}

function buildLevelOptions(){
  els.level.innerHTML = "";
  [1,2,3].forEach(lv=>{
    const opt = document.createElement("option");
    opt.value = String(lv);
    opt.textContent = levelLabel(lv);
    els.level.appendChild(opt);
  });
}

function updateDirectionHint(){
  const qt = els.quizType.value;
  const disabled = (qt === "mix");
  els.direction.disabled = disabled;
  if(els.directionHint){
    els.directionHint.textContent = disabled
      ? "ミックスでは、形問題は英語表記の形当て、系列問題は（日→英）固定です。"
      : "4択・打ち込みで使用します。";
  }
}

// ---- question generation ----
function poolByLevel(level){
  return WORDS.filter(w=>w.level===level);
}

function pickDistractors(pool, correctWord, field, count){
  const used = new Set([norm(correctWord[field])]);
  const out = [];
  let guard=0;
  while(out.length<count && guard++<3000){
    const w = sample(pool);
    const v = norm(w[field]);
    if(!v || used.has(v)) continue;
    used.add(v);
    out.push(w[field]);
  }
  return out;
}

function makeMCWordQuestion(word, dir, pool){
  const ja2en = (dir==="ja_to_en");
  const prompt = ja2en ? word.ja : word.en;
  const correct = ja2en ? word.en : word.ja;
  const field = ja2en ? "en" : "ja";
  const wrongs = pickDistractors(pool, { [field]: correct }, field, 3);
  const options = shuffle([correct, ...wrongs]);
  return {
    kind:"mcWord",
    prompt,
    sub: ja2en ? "日本語 → 英語（4択）" : "英語 → 日本語（4択）",
    options,
    correctSet: new Set([norm(correct)]),
    meta:{ word }
  };
}

function makeTypingWordQuestion(word, dir){
  const ja2en = (dir==="ja_to_en");
  const prompt = ja2en ? word.ja : word.en;
  const correct = ja2en ? word.en : word.ja;
  return {
    kind:"typing",
    prompt,
    sub: ja2en ? "日本語 → 英語（打ち込み）" : "英語 → 日本語（打ち込み）",
    correctSet: new Set([norm(correct)]),
    meta:{ word }
  };
}

// Mix: 5 verb-form (choose which form), 5 series (ja->en 4-choice)
function makeVerbFormQuestion(levelPool){
  const verbs = levelPool.filter(w=>w.forms);
  if(verbs.length < 8){
    // fallback
    return makeMCWordQuestion(sample(levelPool), "ja_to_en", levelPool);
  }
  const w = sample(verbs);
  const keys = ["base","past","pp"];
  const askedKey = sample(keys);
  const shown = w.forms[askedKey];

  const labels = { base:"現在形", past:"過去形", pp:"過去分詞" };
  // Multiple correct labels if shown string equals multiple forms (e.g., cut/put)
  const correctLabels = keys.filter(k=>norm(w.forms[k])===norm(shown)).map(k=>labels[k]);

  const options = shuffle([labels.base, labels.past, labels.pp, "どれでもない"]);
  return {
    kind:"mixVerbForm",
    prompt: `「${shown}」はどの形？`,
    sub: `動詞：${w.forms.base}（${w.ja}）`,
    options,
    correctSet: new Set(correctLabels.map(norm)),
    meta:{ word:w, shown, correctLabels }
  };
}

function makeSeriesQuestion(levelPool){
  // choose a series with enough words
  const map = new Map();
  for(const w of levelPool){
    const key = w.series || "その他";
    if(!map.has(key)) map.set(key, []);
    map.get(key).push(w);
  }
  const seriesList = [...map.entries()].filter(([_,arr])=>arr.length>=8);
  if(seriesList.length===0){
    return makeMCWordQuestion(sample(levelPool), "ja_to_en", levelPool);
  }
  const [seriesName, arr] = sample(seriesList);
  const w = sample(arr);

  const correct = w.en;
  // distractors: prefer other series
  const used = new Set([norm(correct)]);
  const wrongs = [];
  let guard=0;
  while(wrongs.length<3 && guard++<4000){
    const cand = sample(levelPool);
    if(cand.series === seriesName) continue;
    const v = norm(cand.en);
    if(!v || used.has(v)) continue;
    used.add(v);
    wrongs.push(cand.en);
  }
  while(wrongs.length<3 && guard++<6000){
    const cand = sample(levelPool);
    const v = norm(cand.en);
    if(!v || used.has(v)) continue;
    used.add(v);
    wrongs.push(cand.en);
  }
  const options = shuffle([correct, ...wrongs]);
  return {
    kind:"mixSeries",
    prompt: `【${seriesName}】${w.ja}`,
    sub: "（日→英 4択）",
    options,
    correctSet: new Set([norm(correct)]),
    meta:{ word:w, series:seriesName }
  };
}

function buildQuestions(config, missOnly=false){
  const level = Number(config.level);
  const levelPool = poolByLevel(level);

  let basePool = levelPool;
  if(missOnly){
    const missWords = Object.values(state.miss||{}).filter(w=>w.level===level);
    basePool = missWords.length ? missWords : Object.values(state.miss||{});
    if(basePool.length < 4) basePool = levelPool;
  }

  const qs = [];
  if(config.quizType === "mc"){
    const picks = shuffle(basePool).slice(0, 10);
    for(const w of picks) qs.push(makeMCWordQuestion(w, config.direction, levelPool));
  }else if(config.quizType === "typing"){
    const picks = shuffle(basePool).slice(0, 10);
    for(const w of picks) qs.push(makeTypingWordQuestion(w, config.direction));
  }else{
    // mix
    for(let i=0;i<5;i++) qs.push(makeVerbFormQuestion(levelPool));
    for(let i=0;i<5;i++) qs.push(makeSeriesQuestion(levelPool));
    return shuffle(qs);
  }
  return qs;
}

// ---- session runtime ----
function startSession({missOnly=false}={}){
  const config = readConfigFromUI();
  state.lastConfig = { ...config };
  saveState();

  const questions = buildQuestions(config, missOnly);
  session = {
    config,
    questions,
    idx: 0,
    correct: 0,
    lock: false,
    autoTimer: null,
    missesThisRun: new Set(),
  };

  screen("quiz");
  renderQuestion();
}

function renderQuestion(){
  const q = session.questions[session.idx];
  els.progress.textContent = `${session.idx+1} / ${session.questions.length}`;

  // qType pill
  const qt = session.config.quizType;
  if(qt==="mc") els.qTypePill.textContent = "4択";
  else if(qt==="typing") els.qTypePill.textContent = "打ち込み";
  else els.qTypePill.textContent = (q.kind==="mixVerbForm") ? "形" : "系";

  els.qText.textContent = q.prompt;

  // reset UI
  els.feedback.textContent = "";
  els.nextBtn.disabled = true;

  els.choices.innerHTML = "";
  els.choices.classList.remove("hidden");
  els.typing.classList.add("hidden");
  els.typing.setAttribute("aria-hidden","true");
  els.typeInput.value = "";
  els.typeInput.disabled = false;
  els.checkBtn.disabled = false;

  if(q.kind === "typing"){
    els.choices.classList.add("hidden");
    els.typing.classList.remove("hidden");
    els.typing.setAttribute("aria-hidden","false");
    els.typeMeaning.textContent = q.sub || "";
    els.typeExample.textContent = "";
    setTimeout(()=>els.typeInput.focus(), 0);
  }else{
    // mc
    els.typeMeaning.textContent = q.sub || "";
    q.options.forEach(opt=>{
      const btn = document.createElement("button");
      btn.className = "choice";
      btn.type = "button";
      btn.textContent = opt;
      btn.onclick = ()=> submitAnswer(opt);
      els.choices.appendChild(btn);
    });
  }
}

function pushRolling(ok){
  state.rolling.push(Boolean(ok));
  if(state.rolling.length > ROLLING_N) state.rolling = state.rolling.slice(-ROLLING_N);
}

function addMiss(word){
  if(!word) return;
  const k = keyOf(word);
  if(!state.miss[k]){
    state.miss[k] = { ...word, misses: 0 };
  }
  state.miss[k].misses = (state.miss[k].misses || 0) + 1;
  session.missesThisRun.add(k);
}

function submitAnswer(raw){
  if(session.lock) return;
  const q = session.questions[session.idx];

  session.lock = true;

  let ok=false;
  if(q.kind === "typing"){
    const ans = norm(raw);
    ok = q.correctSet.has(ans);
  }else{
    const ans = norm(raw);
    ok = q.correctSet.has(ans);
  }

  state.totalAns += 1;
  if(ok){
    state.totalOk += 1;
    session.correct += 1;
  }else{
    // record miss only for vocabulary questions
    if(q.meta && q.meta.word){
      addMiss(q.meta.word);
    }
  }
  pushRolling(ok);
  saveState();
  refreshStats();
  refreshRank();

  // feedback
  if(ok){
    els.feedback.textContent = "✅ 正解！";
  }else{
    let right = "";
    if(q.kind==="typing"){
      // single answer
      right = [...q.correctSet][0];
    }else if(q.kind==="mixVerbForm"){
      right = (q.meta.correctLabels||[]).join(" / ");
    }else{
      right = [...q.correctSet][0];
    }
    els.feedback.textContent = `❌ 不正解　正解：${right}`;
  }

  // mark choices
  if(q.kind !== "typing"){
    const buttons = [...els.choices.querySelectorAll("button")];
    buttons.forEach(b=>{
      b.disabled = true;
      const v = norm(b.textContent);
      if(q.correctSet.has(v)) b.classList.add("correct");
    });
    const picked = buttons.find(b=>norm(b.textContent)===norm(raw));
    if(picked && !q.correctSet.has(norm(raw))) picked.classList.add("wrong");
  }else{
    els.typeInput.disabled = true;
    els.checkBtn.disabled = true;
  }

  els.nextBtn.disabled = false;

  // auto next
  const delay = ok ? 650 : 950;
  if(session.autoTimer) clearTimeout(session.autoTimer);
  session.autoTimer = setTimeout(()=>{
    if(!els.quiz.classList.contains("hidden")){
      goNext();
    }
  }, delay);
}

function goNext(){
  if(session.autoTimer){ clearTimeout(session.autoTimer); session.autoTimer=null; }

  if(session.idx < session.questions.length-1){
    session.idx += 1;
    session.lock = false;
    renderQuestion();
  }else{
    finishSession();
  }
}

function finishSession(){
  // render result
  const total = session.questions.length;
  const acc = Math.round((session.correct/total)*100);
  els.resultText.textContent = `正解：${session.correct} / ${total}（${acc}%）`;

  // miss list
  els.missList.innerHTML = "";
  const missKeys = [...session.missesThisRun];
  if(missKeys.length===0){
    const li = document.createElement("li");
    li.textContent = "ミスはありませんでした。";
    li.className = "muted";
    els.missList.appendChild(li);
  }else{
    const missWords = missKeys.map(k=>state.miss[k]).filter(Boolean)
      .sort((a,b)=>(b.misses||0)-(a.misses||0));
    missWords.forEach(w=>{
      const li = document.createElement("li");
      li.innerHTML = `<b>${escapeHtml(w.en)}</b> — ${escapeHtml(w.ja)} <span class="muted">（Lv${w.level} / ${escapeHtml(w.series)} / ミス${w.misses||1}）</span>`;
      els.missList.appendChild(li);
    });
  }

  screen("result");
}

function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, (c)=>({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  })[c]);
}

// ---- setup UI sync ----
function syncSetupUI(){
  els.userName.value = state.userName || "";
  const c = state.lastConfig || { level:1, quizType:"mc", direction:"en_to_ja" };
  els.level.value = String(c.level||1);
  els.quizType.value = c.quizType || "mc";
  els.direction.value = c.direction || "en_to_ja";
  updateDirectionHint();
}
function readConfigFromUI(){
  return {
    level: Number(els.level.value)||1,
    quizType: els.quizType.value,
    direction: els.direction.value,
  };
}

// ---- events ----
function wire(){
  els.saveUserBtn.onclick = ()=>{
    state.userName = (els.userName.value||"").trim().slice(0,20);
    saveState();
    els.feedback.textContent = "保存しました";
    setTimeout(()=>{ if(screen){} }, 0);
  };

  els.quizType.onchange = updateDirectionHint;

  els.startBtn.onclick = ()=> startSession({ missOnly:false });
  els.reviewBtn.onclick = ()=> startSession({ missOnly:true });

  els.resetBtn.onclick = ()=>{
    if(confirm("保存データ（正答数・正答率履歴・ミス単語）を初期化します。よろしいですか？")){
      resetState();
    }
  };

  els.quitBtn.onclick = ()=>{
    // stop timers
    if(session && session.autoTimer) clearTimeout(session.autoTimer);
    screen("setup");
  };

  els.nextBtn.onclick = ()=> goNext();

  els.checkBtn.onclick = ()=>{
    if(session && !session.lock){
      submitAnswer(els.typeInput.value);
    }
  };

  els.typeInput.addEventListener("keydown", (e)=>{
    if(e.key==="Enter"){
      e.preventDefault();
      if(session && !session.lock){
        submitAnswer(els.typeInput.value);
      }
    }
  });

  els.backBtn.onclick = ()=> screen("setup");
  els.retryMissBtn.onclick = ()=> startSession({ missOnly:true });
}

// ---- init ----
(async function init(){
  state = loadState();
  buildLevelOptions();
  buildRankList();
  syncSetupUI();
  refreshStats();
  refreshRank();
  screen("setup");

  try{
    WORDS = await loadWords();
  }catch(e){
    console.error(e);
    alert(String(e?.message || e));
  }
})();
