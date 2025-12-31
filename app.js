/* Vocab Trainer 1500
 * - words.json: [{en,ja,level,series,forms?}]
 * - Modes:
 *   mc10: 4-choice x10 (ja2en / en2ja)
 *   type10: typing x10 (ja2en / en2ja)
 *   mix10: 10 questions = verb-form(5) + series(5)
 *      - verb-form: choose which form (base/past/pp)
 *      - series: show series + Japanese, choose English (4 choices)
 * - Rank: rolling accuracy over last 50 answers
 */

const $ = (id) => document.getElementById(id);

const STORAGE_KEY = "vt1500_state_v1";
const ROLLING_N = 50;
const MIN_HISTORY_FOR_RANK = 30;
const PROMOTE_ACC = 0.85;
const DEMOTE_ACC = 0.70;

const state = {
  words: [],
  byLevel: {1:[],2:[],3:[]},
  byLevelSeries: {1:new Map(),2:new Map(),3:new Map()},
  verbCandidates: {1:[],2:[],3:[]},
  ui: {},
  session: null,
  profile: loadProfile(),
};

function loadProfile(){
  try{
    const raw = localStorage.getItem(STORAGE_KEY);
    if(!raw) return { rank: 1, rolling: [] }; // rolling: boolean[] newest last
    const p = JSON.parse(raw);
    if(!p || typeof p.rank !== "number" || !Array.isArray(p.rolling)) throw 0;
    p.rank = Math.min(3, Math.max(1, p.rank|0));
    p.rolling = p.rolling.map(Boolean).slice(-ROLLING_N);
    return p;
  }catch{
    return { rank: 1, rolling: [] };
  }
}
function saveProfile(){
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.profile));
}
function resetProfile(){
  localStorage.removeItem(STORAGE_KEY);
  state.profile = { rank: 1, rolling: [] };
  refreshHeader();
}

function rollingAccuracy(){
  const arr = state.profile.rolling;
  if(arr.length === 0) return null;
  const ok = arr.filter(Boolean).length;
  return ok / arr.length;
}

function refreshHeader(){
  $("rankText").textContent = String(state.profile.rank);
  const acc = rollingAccuracy();
  $("accText").textContent = acc === null ? "--%" : Math.round(acc*100) + "%";
  // おすすめ難易度：ランクに合わせる
  const suggested = String(state.profile.rank);
  $("levelSel").value = suggested;
}

function normalize(s){
  return String(s ?? "").trim().toLowerCase();
}
function shuffle(arr){
  for(let i=arr.length-1;i>0;i--){
    const j=Math.floor(Math.random()*(i+1));
    [arr[i],arr[j]]=[arr[j],arr[i]];
  }
  return arr;
}
function sample(arr){
  return arr[Math.floor(Math.random()*arr.length)];
}
function uniqBy(arr, keyFn){
  const seen = new Set();
  const out = [];
  for(const x of arr){
    const k = keyFn(x);
    if(seen.has(k)) continue;
    seen.add(k);
    out.push(x);
  }
  return out;
}

async function loadWords(){
  const res = await fetch("words.json", {cache:"no-cache"});
  if(!res.ok) throw new Error("words.json を読み込めませんでした");
  const raw = await res.json();

  // 互換：旧形式 { levels: [{id,name,words:[{en,ja,forms?}]}] } も受け入れる
  let words = raw;
  if(!Array.isArray(words) && raw && Array.isArray(raw.levels)){
    const mapLevel = (id)=> id?.includes("easy") ? 1 : (id?.includes("normal") ? 2 : 3);
    words = raw.levels.flatMap(l => (l.words||[]).map(w => ({
      en: w.en,
      ja: w.ja,
      level: mapLevel(l.id),
      series: l.name || l.id || "名詞/その他",
      forms: w.forms
    })));
  }

  if(!Array.isArray(words)) throw new Error("words.json の形式が不正です（配列でも旧levels形式でもありません）");

  // validate minimal
  const cleaned = [];
  for(const w of words){
    if(!w || typeof w.en !== "string" || typeof w.ja !== "string") continue;
    const level = Number(w.level);
    if(!(level===1||level===2||level===3)) continue;
    const series = typeof w.series === "string" ? w.series : "名詞/その他";
    const entry = { en: w.en, ja: w.ja, level, series };
    if(w.forms && typeof w.forms.base==="string" && typeof w.forms.past==="string" && typeof w.forms.pp==="string"){
      entry.forms = { base: w.forms.base, past: w.forms.past, pp: w.forms.pp };
    }
    cleaned.push(entry);
  }

  // enforce 500 each? Not required, but expected.
  state.words = cleaned;
  state.byLevel = {1:[],2:[],3:[]};
  state.byLevelSeries = {1:new Map(),2:new Map(),3:new Map()};
  state.verbCandidates = {1:[],2:[],3:[]};

  for(const w of cleaned){
    state.byLevel[w.level].push(w);

    // series map
    const map = state.byLevelSeries[w.level];
    if(!map.has(w.series)) map.set(w.series, []);
    map.get(w.series).push(w);

    if(w.forms) state.verbCandidates[w.level].push(w);
  }

  // final sanity: 500 each recommended
  refreshHeader();
}

function show(id){
  $("home").classList.add("hidden");
  $("quiz").classList.add("hidden");
  $("result").classList.add("hidden");
  $(id).classList.remove("hidden");
}

function setQuizMeta(){
  const s = state.session;
  $("modeText").textContent = s.mode;
  $("levelText").textContent = "Lv" + s.level;
  $("progText").textContent = `${s.index+1} / ${s.total}`;
  $("scoreText").textContent = String(s.correct);
}

function setPrompt(main, sub=""){
  $("promptMain").textContent = main;
  $("promptSub").textContent = sub || " ";
}

function clearInteraction(){
  $("mcArea").innerHTML = "";
  $("mcArea").classList.add("hidden");
  $("typeArea").classList.add("hidden");
  $("feedback").classList.add("hidden");
  $("nextBtn").classList.add("hidden");
  $("typeInput").value = "";
  $("typeInput").disabled = false;
}

function showFeedback(isCorrect, big, small){
  const fb = $("feedback");
  fb.classList.remove("hidden","good","bad");
  fb.classList.add(isCorrect ? "good" : "bad");
  fb.innerHTML = `<div class="big">${escapeHtml(big)}</div><div class="small">${escapeHtml(small)}</div>`;
}

function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, (m)=>({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[m]));
}

function renderChoices(options, correctIndex, onPick){
  const area = $("mcArea");
  area.classList.remove("hidden");
  area.innerHTML = "";
  options.forEach((opt, i)=>{
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "choice";
    btn.textContent = opt;
    btn.onclick = ()=>{
      // lock
      [...area.querySelectorAll("button")].forEach(b=>b.disabled=true);
      btn.classList.add(i===correctIndex ? "correct":"wrong");
      // also mark correct
      if(i!==correctIndex){
        area.querySelectorAll("button")[correctIndex].classList.add("correct");
      }
      onPick(i===correctIndex, opt);
    };
    area.appendChild(btn);
  });
}

function pushRolling(isCorrect){
  state.profile.rolling.push(Boolean(isCorrect));
  if(state.profile.rolling.length > ROLLING_N){
    state.profile.rolling = state.profile.rolling.slice(-ROLLING_N);
  }
  saveProfile();
  refreshHeader();
}

function applyRankRule(){
  const acc = rollingAccuracy();
  const n = state.profile.rolling.length;
  if(acc === null || n < MIN_HISTORY_FOR_RANK){
    return { changed:false, note:`履歴 ${n}問（判定は${MIN_HISTORY_FOR_RANK}問以上）` };
  }

  const before = state.profile.rank;
  let after = before;

  if(acc >= PROMOTE_ACC) after = Math.min(3, before + 1);
  else if(acc < DEMOTE_ACC) after = Math.max(1, before - 1);

  state.profile.rank = after;
  saveProfile();
  refreshHeader();

  if(after > before) return { changed:true, note:`正答率 ${Math.round(acc*100)}% で昇格` };
  if(after < before) return { changed:true, note:`正答率 ${Math.round(acc*100)}% で降格` };
  return { changed:false, note:`正答率 ${Math.round(acc*100)}%（維持）` };
}

function startSession(){
  const level = Number($("levelSel").value);
  const dir = $("dirSel").value; // ja2en / en2ja
  const mode = $("modeSel").value; // mc10/type10/mix10

  // session plan
  const total = 10;
  const plan = [];

  if(mode === "mix10"){
    // 5 verb-form + 5 series(ja->en)
    for(let i=0;i<5;i++) plan.push({kind:"verbForm"});
    for(let i=0;i<5;i++) plan.push({kind:"seriesJa2En"});
    shuffle(plan);
  }else{
    for(let i=0;i<10;i++) plan.push({kind: mode==="mc10" ? "mc" : "type"});
  }

  state.session = {
    level, dir, mode,
    total,
    index: 0,
    correct: 0,
    plan,
    history: [], // {q, correct, yourAnswer, correctAnswer}
    current: null,
  };

  show("quiz");
  nextQuestion();
}

function pickWord(level){
  const list = state.byLevel[level];
  return sample(list);
}

function pickDistractors(level, correctWord, count, field){ // field: "en" or "ja"
  const list = state.byLevel[level];
  const used = new Set([normalize(correctWord[field])]);
  const out = [];
  let guard = 0;
  while(out.length < count && guard++ < 2000){
    const w = sample(list);
    const v = normalize(w[field]);
    if(!v || used.has(v)) continue;
    used.add(v);
    out.push(w[field]);
  }
  return out;
}

function makeMCQuestion(level, dir){
  const w = pickWord(level);
  if(dir==="ja2en"){
    const correct = w.en;
    const wrongs = pickDistractors(level, w, 3, "en");
    const options = shuffle([correct, ...wrongs]);
    return {
      kind:"mc",
      promptMain: w.ja,
      promptSub: "日本語 → 英語（4択）",
      options,
      correctIndex: options.indexOf(correct),
      correctAnswer: correct,
      meta: { en:w.en, ja:w.ja, series:w.series }
    };
  }else{
    const correct = w.ja;
    const wrongs = pickDistractors(level, w, 3, "ja");
    const options = shuffle([correct, ...wrongs]);
    return {
      kind:"mc",
      promptMain: w.en,
      promptSub: "英語 → 日本語（4択）",
      options,
      correctIndex: options.indexOf(correct),
      correctAnswer: correct,
      meta: { en:w.en, ja:w.ja, series:w.series }
    };
  }
}

function makeTypeQuestion(level, dir){
  const w = pickWord(level);
  if(dir==="ja2en"){
    return {
      kind:"type",
      promptMain: w.ja,
      promptSub: "日本語 → 英語（打ち込み）",
      correctAnswer: w.en,
      meta: { en:w.en, ja:w.ja, series:w.series }
    };
  }else{
    return {
      kind:"type",
      promptMain: w.en,
      promptSub: "英語 → 日本語（打ち込み）",
      correctAnswer: w.ja,
      meta: { en:w.en, ja:w.ja, series:w.series }
    };
  }
}

function makeVerbFormQuestion(level){
  const candidates = state.verbCandidates[level];
  if(candidates.length < 10){
    // fallback: if too few verbs, downgrade to normal MC ja2en
    return makeMCQuestion(level, "ja2en");
  }
  const w = sample(candidates);
  const keys = ["base","past","pp"];
  const key = sample(keys);
  const shown = w.forms[key];
  const labels = { base:"現在形", past:"過去形", pp:"過去分詞" };
  const options = shuffle(keys.map(k=>labels[k]));
  const correctLabel = labels[key];
  return {
    kind:"verbForm",
    promptMain: `「${shown}」はどの形？`,
    promptSub: `動詞（${w.forms.base}）の形当て（4択）`,
    options,
    correctIndex: options.indexOf(correctLabel),
    correctAnswer: correctLabel,
    meta: { en:w.forms.base, ja:w.ja, series:w.series, forms:w.forms, asked:key }
  };
}

function makeSeriesJa2EnQuestion(level){
  // choose a series with at least 8 words (avoid tiny series)
  const map = state.byLevelSeries[level];
  const seriesList = [...map.entries()].filter(([k,arr])=>arr.length>=8);
  if(seriesList.length===0){
    return makeMCQuestion(level, "ja2en");
  }
  const [seriesName, arr] = sample(seriesList);
  const w = sample(arr);
  const correct = w.en;

  // distractors: from other series preferably
  const all = state.byLevel[level];
  const used = new Set([normalize(correct)]);
  const wrongs = [];
  let guard=0;
  while(wrongs.length<3 && guard++<3000){
    const cand = sample(all);
    if(cand.series === seriesName) continue;
    const v = normalize(cand.en);
    if(!v || used.has(v)) continue;
    used.add(v);
    wrongs.push(cand.en);
  }
  // if not enough, fill from same level anywhere
  while(wrongs.length<3 && guard++<5000){
    const cand = sample(all);
    const v = normalize(cand.en);
    if(!v || used.has(v)) continue;
    used.add(v);
    wrongs.push(cand.en);
  }

  const options = shuffle([correct, ...wrongs]);
  return {
    kind:"seriesJa2En",
    promptMain: `【${seriesName}】「${w.ja}」は英語で？`,
    promptSub: "系列（カテゴリ）つき（日→英 4択）",
    options,
    correctIndex: options.indexOf(correct),
    correctAnswer: correct,
    meta: { en:w.en, ja:w.ja, series:seriesName }
  };
}

function goNext(){
  const s = state.session;
  s.index += 1;
  nextQuestion();
}

function nextQuestion(){
  const s = state.session;
  clearInteraction();

  // finish?
  if(s.index >= s.total){
    finishSession();
    return;
  }

  setQuizMeta();

  const task = s.plan[s.index];
  let q;
  if(task.kind==="mc") q = makeMCQuestion(s.level, s.dir);
  else if(task.kind==="type") q = makeTypeQuestion(s.level, s.dir);
  else if(task.kind==="verbForm") q = makeVerbFormQuestion(s.level);
  else if(task.kind==="seriesJa2En") q = makeSeriesJa2EnQuestion(s.level);
  else q = makeMCQuestion(s.level, s.dir);

  s.current = q;

  setPrompt(q.promptMain, q.promptSub);

  if(q.kind==="mc" || q.kind==="verbForm" || q.kind==="seriesJa2En"){
    renderChoices(q.options, q.correctIndex, (isCorrect, picked)=>{
      onAnswered(isCorrect, q.correctAnswer, picked);
    });
  }else{
    // type
    $("typeArea").classList.remove("hidden");
    $("typeInput").focus();
  }
}

function onAnswered(isCorrect, correctAnswer, yourAnswer){
  const s = state.session;
  if(isCorrect) s.correct += 1;
  setQuizMeta();
  pushRolling(isCorrect);

  // feedback
  const q = s.current;
  const right = q.correctAnswer;
  if(isCorrect){
    showFeedback(true, "正解！", `答え：${right}`);
  }else{
    showFeedback(false, "不正解", `答え：${right}`);
  }

  // store history
  s.history.push({
    kind: q.kind,
    promptMain: q.promptMain,
    promptSub: q.promptSub,
    meta: q.meta,
    correct: isCorrect,
    correctAnswer: right,
    // yourAnswer for mc is handled in click; for type in submit
    yourAnswer: yourAnswer
  });

  $("nextBtn").classList.remove("hidden");
  // 自動で次へ（4択も自動遷移）
  setTimeout(()=>{
    // すでに画面が切り替わっている場合は何もしない
    if(!$("quiz").classList.contains("hidden")){
      goNext();
    }
  }, 800);
}

function finishSession(){
  // rank update at end
  const rankInfo = applyRankRule();

  show("result");
  const s = state.session;
  $("resultScore").textContent = `${s.correct} / ${s.total}`;
  $("resultAcc").textContent = `正答率 ${Math.round((s.correct/s.total)*100)}%`;

  $("rankAfter").textContent = `ランク ${state.profile.rank}`;
  $("rankNote").textContent = rankInfo.note;

  // review list
  const list = $("reviewList");
  list.innerHTML = "";
  for(const h of s.history){
    const div = document.createElement("div");
    div.className = "revItem";
    const tag = h.correct ? "✅" : "❌";
    const meta = h.meta || {};
    let extra = "";
    if(h.kind==="verbForm" && meta.forms){
      extra = `（base: ${meta.forms.base}, past: ${meta.forms.past}, pp: ${meta.forms.pp}）`;
    }else{
      extra = `（${meta.en ?? ""} / ${meta.ja ?? ""} / ${meta.series ?? ""}）`;
    }
    div.innerHTML = `<b>${tag} ${escapeHtml(h.promptMain)}</b><div class="small">${escapeHtml("答え： " + h.correctAnswer + " " + extra)}</div>`;
    list.appendChild(div);
  }
}

function wire(){
  $("startBtn").onclick = startSession;
  $("quitBtn").onclick = ()=>{ show("home"); };
  $("backHomeBtn").onclick = ()=>{ show("home"); };
  $("retryBtn").onclick = ()=>{ startSession(); };
  $("nextBtn").onclick = goNext;

  $("typeArea").addEventListener("submit", (ev)=>{
    ev.preventDefault();
    const s = state.session;
    const q = s.current;
    const inp = $("typeInput");
    const your = inp.value.trim();
    inp.disabled = true;

    const correct = normalize(your) === normalize(q.correctAnswer);
    if(correct) s.correct += 1;
    setQuizMeta();
    pushRolling(correct);

    if(correct){
      showFeedback(true, "正解！", `答え：${q.correctAnswer}`);
    }else{
      showFeedback(false, "不正解", `答え：${q.correctAnswer} ／ あなた：${your || "（未入力）"}`);
    }

    s.history.push({
      kind: q.kind,
      promptMain: q.promptMain,
      promptSub: q.promptSub,
      meta: q.meta,
      correct,
      correctAnswer: q.correctAnswer,
      yourAnswer: your
    });

    $("nextBtn").classList.remove("hidden");
  // 自動で次へ（4択も自動遷移）
  setTimeout(()=>{
    // すでに画面が切り替わっている場合は何もしない
    if(!$("quiz").classList.contains("hidden")){
      goNext();
    }
  }, 800);
    // 自動遷移（連打加点を防ぐ）
    setTimeout(()=>{
      if(!$("quiz").classList.contains("hidden")){
        goNext();
      }
    }, 800);
  });

  $("resetBtn").onclick = ()=>{
    if(confirm("学習履歴（ランク・正答率履歴）をリセットします。よろしいですか？")){
      resetProfile();
      alert("リセットしました");
    }
  };

  // rank change -> suggest level
  refreshHeader();
}

(async function main(){
  try{
    wire();
    await loadWords();
    show("home");
  }catch(e){
    console.error(e);
    alert(String(e?.message || e));
  }
})();
