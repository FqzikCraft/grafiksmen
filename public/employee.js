const $=(selector,root=document)=>root.querySelector(selector);
const $$=(selector,root=document)=>[...root.querySelectorAll(selector)];
const root=$('#employeeRoot');
const params=new URLSearchParams(location.hash.slice(1));
let access=params.get('token')||'';
let invite=params.get('invite')||'';
let person=null,weekOffset=0,stored=[],assignedShifts=[];
let employeeView=access?'schedule':'availability';

const days=()=>{
 const now=new Date();now.setHours(12,0,0,0);now.setDate(now.getDate()+weekOffset*7);now.setDate(now.getDate()-((now.getDay()+6)%7));
 return Array.from({length:7},(_,i)=>{const d=new Date(now);d.setDate(now.getDate()+i);return{date:`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`,day:d.getDate(),dow:new Intl.DateTimeFormat('ru-RU',{weekday:'short'}).format(d),month:new Intl.DateTimeFormat('ru-RU',{month:'long'}).format(d),shortMonth:new Intl.DateTimeFormat('ru-RU',{month:'short'}).format(d)}});
};
const cap=s=>s[0].toUpperCase()+s.slice(1);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const api=async(action,payload={},method='POST')=>{
 const url=method==='GET'? `/api/run?action=${action}&${new URLSearchParams(payload)}`:`/api/run?action=${action}`;
 const response=await fetch(url,{method,headers:method==='GET'?{}:{'Content-Type':'application/json'},body:method==='GET'?undefined:JSON.stringify(payload)});
 const result=await response.json().catch(()=>({}));
 if(!response.ok)throw Error(result.error||'Не удалось выполнить запрос');
 return result;
};
function toast(message){const box=document.createElement('div');box.className='toast';box.textContent=message;$('#toastRoot').append(box);setTimeout(()=>box.remove(),2600)}
const range=()=>{const d=days();return{from:d[0].date,to:d[6].date}};
const rangeLabel=d=>`${d[0].day} ${d[0].shortMonth} – ${d[6].day} ${d[6].shortMonth} ${d[6].date.slice(0,4)}`;
const plural=(n,a,b,c)=>n%10===1&&n%100!==11?a:n%10>=2&&n%10<=4&&(n%100<12||n%100>14)?b:c;

function workerTabs(){return `<nav class="employee-tabs" aria-label="Разделы профиля"><button class="${employeeView==='schedule'?'active':''}" onclick="window.setEmployeeView('schedule')">◷ Мои смены</button><button class="${employeeView==='availability'?'active':''}" onclick="window.setEmployeeView('availability')">✓ Доступность</button></nav>`}
function weekControls(d){return `<div class="employee-week-nav"><button class="arrow" id="prevWeek" aria-label="Предыдущая неделя">‹</button><strong>${rangeLabel(d)}</strong><button class="arrow" id="nextWeek" aria-label="Следующая неделя">›</button></div>`}
function bindWeekControls(){ $('#prevWeek').onclick=async()=>{weekOffset--;await loadWorker()};$('#nextWeek').onclick=async()=>{weekOffset++;await loadWorker()};}
function renderRegistration(error=''){
 root.innerHTML=`<div class="employee-reg"><div class="employee-hero"><h1>Регистрация сотрудника</h1><p>Заполните данные один раз — и отмечайте удобное время для смен.</p></div><section class="employee-panel"><div class="panel-head"><div><h2>Ваши данные</h2><div class="panel-help">Если вы уже регистрировались, введите те же имя, фамилию и Telegram — откроется ваш профиль.</div></div></div><form id="registerForm"><div class="form-field"><label for="firstName">Имя</label><input id="firstName" autocomplete="given-name" required maxlength="80" placeholder="Например, Соня"></div><div class="form-field"><label for="lastName">Фамилия</label><input id="lastName" autocomplete="family-name" required maxlength="80" placeholder="Например, Иванова"></div><div class="form-field"><label for="telegramId">Telegram username или ID</label><input id="telegramId" type="text" autocomplete="username" required pattern="([0-9]{4,20}|@?[A-Za-z][A-Za-z0-9_]{4,31})" maxlength="33" placeholder="@fqzik"></div><p class="employee-error" id="regError" role="alert">${esc(error)}</p><button class="button primary employee-save" type="submit">Продолжить <span>→</span></button></form><div class="employee-notice">Если данные уже есть в системе, откроется ваш прежний профиль. При ошибке в имени попросите администратора проверить запись.</div></section></div>`;
 $('#registerForm').onsubmit=async event=>{
  event.preventDefault();const button=$('button[type=submit]',event.currentTarget);button.disabled=true;
  try{const out=await api('register',{invite,firstName:$('#firstName').value.trim(),lastName:$('#lastName').value.trim(),telegramId:$('#telegramId').value.trim()});access=out.token;person=out.employee;invite='';employeeView='availability';history.replaceState({},'',`/employee.html#token=${encodeURIComponent(access)}`);await loadWorker();if(out.existing)toast('Профиль найден — вы вошли в свой аккаунт')}
  catch(error){$('#regError').textContent=error.message}
  finally{button.disabled=false}
 };
}
async function loadWorker(){
 const out=await api('worker_load',{token:access,...range()});
 person=out.employee;stored=out.availability||[];assignedShifts=out.shifts||[];
 if(employeeView==='schedule')renderSchedule();else renderAvailability();
}
window.setEmployeeView=next=>{employeeView=next;if(next==='schedule')renderSchedule();else renderAvailability()};

function renderSchedule(){
 const d=days(),byDate=new Map();
 for(const shift of assignedShifts){if(!byDate.has(shift.date))byDate.set(shift.date,[]);byDate.get(shift.date).push(shift)}
 const dayCards=d.map(day=>{
  const rows=(byDate.get(day.date)||[]).sort((a,b)=>a.start.localeCompare(b.start));
  return `<article class="employee-shift-day"><header><strong>${cap(day.dow)}, ${day.day} ${day.month}</strong><span>${rows.length} ${plural(rows.length,'смена','смены','смен')}</span></header>${rows.length?rows.map(s=>`<div class="employee-shift-card"><span class="employee-shift-time">${esc(s.start)}–${esc(s.end)}</span><div><strong>${esc(s.pointName||'Точка')}</strong><small>${esc(s.pointAddress||'Адрес не указан')}</small></div></div>`).join(''):`<div class="employee-shift-empty">Назначенных смен нет</div>`}</article>`;
 }).join('');
 root.innerHTML=`<div class="employee-hero"><h1>Мои смены</h1><p>Ваши назначения на работе в КутиКатай.</p></div>${workerTabs()}<section class="employee-panel"><div class="employee-meta"><div><h2 style="margin:0;font-size:15px">${esc(person.firstName)} ${esc(person.lastName)}</h2><div class="panel-help" style="margin-top:4px">Личный график смен</div></div></div>${weekControls(d)}<div class="employee-shift-list">${dayCards}</div><div class="employee-notice">Если в графике пока нет смен, проверьте следующую неделю позже или уточните у администратора.</div></section>`;
 bindWeekControls();
}
function renderAvailability(message=''){
 const d=days(),map=new Map(stored.map(x=>[x.date,x]));
 root.innerHTML=`<div class="employee-hero"><h1>Когда вы можете выйти?</h1><p>Отметьте доступные дни и укажите своё время на каждый из них.</p></div>${workerTabs()}${message?`<div class="employee-done">${esc(message)}</div>`:''}<section class="employee-panel"><div class="employee-meta"><div><h2 style="margin:0;font-size:15px">${esc(person.firstName)} ${esc(person.lastName)}</h2><div class="panel-help" style="margin-top:4px">Ваша доступность на неделю</div></div></div>${weekControls(d)}<div class="employee-days">${d.map(x=>{const a=map.get(x.date);return `<label class="employee-day ${a?'enabled':''}"><input class="day-check" type="checkbox" data-date="${x.date}" ${a?'checked':''}><span class="employee-date">${cap(x.dow)}, ${x.day}<small>${cap(x.month)}</small></span><span class="employee-time"><span>С</span><input type="time" data-start="${x.date}" value="${a?.start||'10:00'}" ${a?'':'disabled'}><span>до</span><input type="time" data-end="${x.date}" value="${a?.end||'22:00'}" ${a?'':'disabled'}></span></label>`}).join('')}</div><p class="employee-summary">Время вводится отдельно для каждого дня. Например, в среду можно указать 11:00–22:00, а в пятницу — 17:00–22:00. Если день не выбран, вы не попадёте в список доступных.</p><button class="button primary employee-save" id="saveAvailability">Сохранить доступность <span>→</span></button><div class="employee-notice">Ответ можно обновлять в любое время до публикации графика.</div></section>`;
 bindWeekControls();
 $$('.day-check').forEach(check=>check.addEventListener('change',()=>{const row=check.closest('.employee-day');row.classList.toggle('enabled',check.checked);$$('input[type=time]',row).forEach(input=>input.disabled=!check.checked)}));
 $('#saveAvailability').onclick=async()=>{
  const button=$('#saveAvailability');button.disabled=true;
  try{const entries=[];for(const check of $$('.day-check'))if(check.checked){const date=check.dataset.date,start=$(`[data-start="${date}"]`).value,end=$(`[data-end="${date}"]`).value;if(!start||!end||start>=end)throw Error(`Укажите корректный промежуток времени на ${date}`);entries.push({date,start,end})}const r=range();await api('worker_save',{token:access,...r,days:entries});stored=entries;renderAvailability('Доступность сохранена. Спасибо!');toast('Ваши дни и время сохранены')}
  catch(error){toast(error.message)}
  finally{const current=$('#saveAvailability');if(current)current.disabled=false}
 };
}
if(access)loadWorker().catch(error=>{root.innerHTML=`<div class="employee-reg"><section class="employee-panel"><div class="employee-hero"><h1>Ссылка не найдена</h1><p>${esc(error.message)}. Попросите менеджера прислать новую личную ссылку.</p></div><a class="button primary" href="/">На главную</a></section></div>`});
else if(invite)renderRegistration();
else root.innerHTML=`<div class="employee-reg"><section class="employee-panel"><div class="employee-hero"><h1>Откройте ссылку команды</h1><p>Попросите администратора КутиКатай прислать вам ссылку регистрации или вашу личную ссылку для отметки доступности.</p></div></section></div>`;


