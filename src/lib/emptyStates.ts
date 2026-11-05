import type { MessageLocale } from './friendly';
import type { PoseId } from './messages/types';

/**
 * Empty states of the main list, with the mascot (0.5.0). Like the friendly messages, the line is in the language of
 * the friendly messages (the Beacon user's, else the app's, 7 languages):
 * - `pinned`: nothing pinned and nothing tracked this week, but tracked before → "Pin a task" (scrolls to the list);
 * - `recent`: nothing pinned and never tracked on this computer → "Start a timer" (focuses the search);
 * - `tasks`: no task at all → "Open the tasks in Beacon".
 */
export type EmptyState = 'pinned' | 'recent' | 'tasks';

export const EMPTY_STATES: readonly EmptyState[] = ['pinned', 'recent', 'tasks'];

/**
 * Pose of each empty state: its own art (`pose-empty-<state>`, dropped in later with scripts/mascot/import-poses.sh),
 * else the fallback pose here (`POSE_FALLBACK` in src/ui/mascot.ts).
 */
export const EMPTY_POSES: Record<EmptyState, PoseId> = {
  pinned: 'empty-pinned',
  recent: 'empty-recent',
  tasks: 'empty-tasks',
};

export interface EmptyText {
  /** One short line. */
  line: string;
  /** The button. */
  action: string;
  /** What the picture shows (it carries meaning next to a short line). */
  alt: string;
}

export const EMPTY_TEXTS: Record<MessageLocale, Record<EmptyState, EmptyText>> = {
  en: {
    pinned: { line: 'Nothing pinned yet. Pin the tasks you use most and they wait for you here.', action: 'Pin a task', alt: 'The robot holding a thumbtack' },
    recent: { line: 'No recent tasks this week. Start one and it shows up here.', action: 'Start a timer', alt: 'The robot holding a stopwatch' },
    tasks: { line: 'No tasks assigned to you yet. Beacon has the whole board.', action: 'Open the tasks in Beacon', alt: 'The robot waving from a blank clipboard' },
  },
  es: {
    pinned: { line: 'Aún no has fijado nada. Fija las tareas que más usas y te esperarán aquí.', action: 'Fija una tarea', alt: 'El robot con una chincheta en la mano' },
    recent: { line: 'Esta semana no hay tareas recientes. Inicia una y aparecerá aquí.', action: 'Inicia un temporizador', alt: 'El robot con un cronómetro en la mano' },
    tasks: { line: 'Todavía no tienes tareas asignadas. En Beacon está el tablero completo.', action: 'Abrir las tareas en Beacon', alt: 'El robot saluda sentado en un portapapeles en blanco' },
  },
  de: {
    pinned: { line: 'Noch nichts angeheftet. Hefte deine häufigsten Aufgaben an, dann warten sie hier.', action: 'Aufgabe anheften', alt: 'Der Roboter hält eine Pinnnadel' },
    recent: { line: 'Diese Woche noch keine Aufgaben. Starte eine, dann erscheint sie hier.', action: 'Timer starten', alt: 'Der Roboter hält eine Stoppuhr' },
    tasks: { line: 'Dir sind noch keine Aufgaben zugewiesen. In Beacon siehst du das ganze Board.', action: 'Aufgaben in Beacon öffnen', alt: 'Der Roboter winkt von einem leeren Klemmbrett' },
  },
  fr: {
    pinned: { line: 'Rien d’épinglé pour l’instant. Épingle tes tâches favorites, elles t’attendront ici.', action: 'Épingler une tâche', alt: 'Le robot tient une punaise' },
    recent: { line: 'Aucune tâche récente cette semaine. Lances-en une et elle apparaîtra ici.', action: 'Lancer un minuteur', alt: 'Le robot tient un chronomètre' },
    tasks: { line: 'Aucune tâche ne t’est encore assignée. Beacon a le tableau complet.', action: 'Ouvrir les tâches dans Beacon', alt: 'Le robot salue, assis sur un porte-bloc vide' },
  },
  it: {
    pinned: { line: 'Ancora niente di fissato. Fissa le attività che usi di più e ti aspetteranno qui.', action: 'Fissa un’attività', alt: 'Il robot tiene una puntina' },
    recent: { line: 'Nessuna attività recente questa settimana. Avviane una e comparirà qui.', action: 'Avvia un timer', alt: 'Il robot tiene un cronometro' },
    tasks: { line: 'Non hai ancora attività assegnate. Su Beacon c’è la bacheca completa.', action: 'Apri le attività in Beacon', alt: 'Il robot saluta seduto su una cartellina vuota' },
  },
  nl: {
    pinned: { line: 'Nog niets vastgezet. Zet je vaste taken vast, dan wachten ze hier op je.', action: 'Taak vastzetten', alt: 'De robot houdt een punaise vast' },
    recent: { line: 'Deze week nog geen recente taken. Start er een en hij verschijnt hier.', action: 'Timer starten', alt: 'De robot houdt een stopwatch vast' },
    tasks: { line: 'Er zijn nog geen taken aan je toegewezen. In Beacon staat het hele bord.', action: 'Taken openen in Beacon', alt: 'De robot zwaait vanaf een leeg klembord' },
  },
  pt: {
    pinned: { line: 'Ainda nada fixado. Fixa as tarefas que mais usas e elas esperam por ti aqui.', action: 'Fixar uma tarefa', alt: 'O robô segura um pionés' },
    recent: { line: 'Sem tarefas recentes esta semana. Inicia uma e ela aparece aqui.', action: 'Iniciar um temporizador', alt: 'O robô segura um cronómetro' },
    tasks: { line: 'Ainda não tens tarefas atribuídas. No Beacon está o quadro completo.', action: 'Abrir as tarefas no Beacon', alt: 'O robô acena sentado numa prancheta em branco' },
  },
};

/** "Pin a task": where the pin button is (shown as a notice while the list scrolls into view). */
export const PIN_HINT: Record<MessageLocale, string> = {
  en: 'Use the pin next to a task: it stays at the top, with Alt+1…9.',
  es: 'Usa la chincheta junto a una tarea: se queda arriba, con Alt+1…9.',
  de: 'Nutze die Pinnadel neben einer Aufgabe: Sie bleibt oben, mit Alt+1…9.',
  fr: 'Utilise l’épingle à côté d’une tâche : elle reste en haut, avec Alt+1…9.',
  it: 'Usa la puntina accanto a un’attività: resta in alto, con Alt+1…9.',
  nl: 'Gebruik de punaise naast een taak: hij blijft bovenaan, met Alt+1…9.',
  pt: 'Usa o pionés ao lado de uma tarefa: fica no topo, com Alt+1…9.',
};

/** Which empty state the pinned / recent section shows (`null`: it has tasks). */
export function quickEmptyState(quickCount: number, trackedBefore: boolean): EmptyState | null {
  if (quickCount > 0) return null;
  return trackedBefore ? 'pinned' : 'recent';
}
