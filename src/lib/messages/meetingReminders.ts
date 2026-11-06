import type { MessageLocale } from '../friendly';

/**
 * Meeting reminders (`src/lib/meetingReminders.ts`, contract §23.4), per locale: the notification texts and buttons.
 * `{minutes}`, `{count}`, `{time}`, `{meeting}` (title, or *Busy* for a private meeting) and `{task}` are filled in.
 */
export interface MeetingReminderCatalog {
  /** Title of a private meeting (spec 210: never its real title). */
  busy: string;
  inMinutes: string;
  startingNow: string;
  /** After the body when the list is older than an hour. */
  outdated: string;
  /** More internal attendees than the three named. */
  more: string;
  /** Count of people outside Beacon (never their names). */
  externals: string;
  /** More than three reminders in the same minute: one notification. */
  groupTitle: string;
  groupBody: string;
  /** Rule 5: the meeting started while a timer runs. */
  startTitle: string;
  startAsk: string;
  /** Automatic pause (opt-in). */
  pausedTitle: string;
  paused: string;
  actions: { join: string; snooze: string; snooze1: string; snooze5: string; dismiss: string; keep: string; pause: string; track: string; undo: string };
}

const en: MeetingReminderCatalog = {
  busy: 'Busy',
  inMinutes: 'in {minutes} min',
  startingNow: 'starting now',
  outdated: '(may be outdated)',
  more: '+{count}',
  externals: '+{count} external',
  groupTitle: '{count} meetings at {time}',
  groupBody: 'Open TimeTrack to see them and join.',
  startTitle: 'Meeting started',
  startAsk: '{meeting} has started. Keep timing "{task}", pause, or track the meeting?',
  pausedTitle: 'Timer paused',
  paused: '{meeting} has started, so "{task}" is paused.',
  actions: { join: 'Join', snooze: 'Snooze', snooze1: '1 min', snooze5: '5 min', dismiss: 'Dismiss', keep: 'Keep timing', pause: 'Pause', track: 'Track the meeting', undo: 'Undo' },
};

const es: MeetingReminderCatalog = {
  busy: 'Ocupado',
  inMinutes: 'en {minutes} min',
  startingNow: 'empieza ya',
  outdated: '(puede no estar al día)',
  more: '+{count}',
  externals: '+{count} externos',
  groupTitle: '{count} reuniones a las {time}',
  groupBody: 'Abre TimeTrack para verlas y unirte.',
  startTitle: 'Ha empezado la reunión',
  startAsk: '{meeting} ya ha empezado. ¿Sigues con «{task}», pausas o registras la reunión?',
  pausedTitle: 'Temporizador en pausa',
  paused: '{meeting} ya ha empezado, así que «{task}» está en pausa.',
  actions: { join: 'Unirme', snooze: 'Posponer', snooze1: '1 min', snooze5: '5 min', dismiss: 'Cerrar', keep: 'Seguir', pause: 'Pausar', track: 'Registrar reunión', undo: 'Deshacer' },
};

const de: MeetingReminderCatalog = {
  busy: 'Beschäftigt',
  inMinutes: 'in {minutes} Min.',
  startingNow: 'beginnt jetzt',
  outdated: '(evtl. nicht aktuell)',
  more: '+{count}',
  externals: '+{count} extern',
  groupTitle: '{count} Meetings um {time}',
  groupBody: 'Öffne TimeTrack, um sie zu sehen und beizutreten.',
  startTitle: 'Meeting hat begonnen',
  startAsk: '{meeting} hat begonnen. „{task}“ weiter erfassen, pausieren oder das Meeting erfassen?',
  pausedTitle: 'Timer pausiert',
  paused: '{meeting} hat begonnen, deshalb ist „{task}“ pausiert.',
  actions: { join: 'Beitreten', snooze: 'Später', snooze1: '1 Min.', snooze5: '5 Min.', dismiss: 'Schließen', keep: 'Weiter erfassen', pause: 'Pausieren', track: 'Meeting erfassen', undo: 'Rückgängig' },
};

const fr: MeetingReminderCatalog = {
  busy: 'Occupé',
  inMinutes: 'dans {minutes} min',
  startingNow: 'commence maintenant',
  outdated: '(peut-être pas à jour)',
  more: '+{count}',
  externals: '+{count} externes',
  groupTitle: '{count} réunions à {time}',
  groupBody: 'Ouvrez TimeTrack pour les voir et les rejoindre.',
  startTitle: 'La réunion a commencé',
  startAsk: '{meeting} a commencé. Continuer « {task} », mettre en pause ou suivre la réunion ?',
  pausedTitle: 'Minuteur en pause',
  paused: '{meeting} a commencé : « {task} » est en pause.',
  actions: { join: 'Rejoindre', snooze: 'Plus tard', snooze1: '1 min', snooze5: '5 min', dismiss: 'Fermer', keep: 'Continuer', pause: 'Pause', track: 'Suivre la réunion', undo: 'Annuler' },
};

const it: MeetingReminderCatalog = {
  busy: 'Occupato',
  inMinutes: 'tra {minutes} min',
  startingNow: 'inizia ora',
  outdated: '(potrebbe non essere aggiornato)',
  more: '+{count}',
  externals: '+{count} esterni',
  groupTitle: '{count} riunioni alle {time}',
  groupBody: 'Apri TimeTrack per vederle e partecipare.',
  startTitle: 'La riunione è iniziata',
  startAsk: '{meeting} è iniziata. Continuare con «{task}», mettere in pausa o registrare la riunione?',
  pausedTitle: 'Timer in pausa',
  paused: '{meeting} è iniziata, quindi «{task}» è in pausa.',
  actions: { join: 'Partecipa', snooze: 'Rimanda', snooze1: '1 min', snooze5: '5 min', dismiss: 'Chiudi', keep: 'Continua', pause: 'Pausa', track: 'Registra riunione', undo: 'Annulla' },
};

const nl: MeetingReminderCatalog = {
  busy: 'Bezet',
  inMinutes: 'over {minutes} min',
  startingNow: 'begint nu',
  outdated: '(mogelijk niet actueel)',
  more: '+{count}',
  externals: '+{count} extern',
  groupTitle: '{count} vergaderingen om {time}',
  groupBody: 'Open TimeTrack om ze te zien en deel te nemen.',
  startTitle: 'Vergadering begonnen',
  startAsk: '{meeting} is begonnen. Doorgaan met ‘{task}’, pauzeren of de vergadering bijhouden?',
  pausedTitle: 'Timer gepauzeerd',
  paused: '{meeting} is begonnen, dus ‘{task}’ is gepauzeerd.',
  actions: { join: 'Deelnemen', snooze: 'Later', snooze1: '1 min', snooze5: '5 min', dismiss: 'Sluiten', keep: 'Doorgaan', pause: 'Pauzeren', track: 'Vergadering bijhouden', undo: 'Ongedaan maken' },
};

const pt: MeetingReminderCatalog = {
  busy: 'Ocupado',
  inMinutes: 'em {minutes} min',
  startingNow: 'começa agora',
  outdated: '(pode estar desatualizado)',
  more: '+{count}',
  externals: '+{count} externos',
  groupTitle: '{count} reuniões às {time}',
  groupBody: 'Abra o TimeTrack para vê-las e entrar.',
  startTitle: 'A reunião começou',
  startAsk: '{meeting} começou. Continuar com «{task}», pausar ou registar a reunião?',
  pausedTitle: 'Temporizador em pausa',
  paused: '{meeting} começou, por isso «{task}» está em pausa.',
  actions: { join: 'Entrar', snooze: 'Adiar', snooze1: '1 min', snooze5: '5 min', dismiss: 'Fechar', keep: 'Continuar', pause: 'Pausar', track: 'Registar reunião', undo: 'Desfazer' },
};

export const MEETING_REMINDERS: Record<MessageLocale, MeetingReminderCatalog> = { en, es, de, fr, it, nl, pt };
