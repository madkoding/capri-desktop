'use strict';

// Talking to her memory in the chat, answered straight from the files (no model, nothing sent):
// "what do you remember about me?" lists it, "forget that I like coffee" forgets that one thing.
// Returns her line, or null when the message is about something else.

const memory = require('./memory');

const plain = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

const LIST = /what (?:do|did) you (?:remember|know) (?:about|of) me|what have you (?:learned|remembered) about me|que (?:te souviens|sais)[- ]tu de moi|de quoi te souviens[- ]tu|que (?:recuerdas|sabes) de mi|o que (?:voce )?(?:lembra|sabe) (?:de|sobre) mim|что ты (?:помнишь|знаешь) обо мне/u;
const FORGET = /^\s*(?:capri,?\s+)?(?:forget|oublie|olvida|esquece|забудь)\s+(?:that\s+|que\s+|что\s+)?(.{3,200})/u;

const T = {
  en: { none: "I don't remember anything about you yet.", head: 'What I remember about you:', gone: (x) => `Forgotten: “${x}”.`, cats: { profile: 'You', preference: 'Likes', fact: 'Facts', project: 'Projects', episode: 'Past chats' } },
  fr: { none: 'Je ne me souviens encore de rien sur toi.', head: 'Ce dont je me souviens sur toi :', gone: (x) => `Oublié : « ${x} ».`, cats: { profile: 'Toi', preference: 'Goûts', fact: 'Faits', project: 'Projets', episode: 'Anciens chats' } },
  es: { none: 'Aún no recuerdo nada de ti.', head: 'Lo que recuerdo de ti:', gone: (x) => `Olvidado: “${x}”.`, cats: { profile: 'Tú', preference: 'Gustos', fact: 'Datos', project: 'Proyectos', episode: 'Charlas pasadas' } },
  pt: { none: 'Ainda não lembro de nada sobre você.', head: 'O que lembro sobre você:', gone: (x) => `Esquecido: “${x}”.`, cats: { profile: 'Você', preference: 'Gostos', fact: 'Fatos', project: 'Projetos', episode: 'Conversas passadas' } },
  ru: { none: 'Я пока ничего о тебе не помню.', head: 'Что я помню о тебе:', gone: (x) => `Забыла: «${x}».`, cats: { profile: 'Ты', preference: 'Вкусы', fact: 'Факты', project: 'Проекты', episode: 'Прошлые чаты' } },
};

function answer(text, lang = 'en') {
  const t = T[lang] || T.en;
  const said = plain(String(text));
  if (LIST.test(said) || LIST.test(String(text).toLowerCase())) {
    const entries = memory.list();
    if (!entries.length) return t.none;
    const lines = [t.head];
    for (const cat of memory.CATEGORIES) {
      const own = entries.filter((e) => e.cat === cat);
      if (own.length) lines.push('', `${t.cats[cat]}:`, ...own.slice(-8).map((e) => `- ${e.text}`));
    }
    return lines.join('\n');
  }
  const query = FORGET.exec(String(text))?.[1];
  const hit = query && memory.find(query);
  if (hit) {
    memory.forget(hit.id);
    return t.gone(hit.text);
  }
  return null;
}

module.exports = { answer };
