import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  ArrowDownToLine,
  ArrowRight,
  ArrowUpFromLine,
  AudioLines,
  BookOpen,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clapperboard,
  Clock3,
  ExternalLink,
  Flame,
  Layers,
  Lightbulb,
  Maximize2,
  Minimize2,
  Repeat2,
  RotateCcw,
  Search,
  Settings2,
  TrendingUp,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import vocabulary from "./data/oxford3000.json";
import topicAssignments from "./data/word-topics.json";
import { films, filmPosters, filmTermLabels } from "./filmCatalog";
import {
  addExtraNewWords,
  defaultState,
  getAvailableWords,
  getDailyNewLimit,
  getNewWords,
  getStats,
  getStudyQueue,
  localDayKey,
  scheduleCard,
} from "./lib/scheduler";
import { parseBackup, readState, writeState, STORAGE_KEY } from "./lib/storage";
import { createSpeechController } from "./lib/speech";
import { createBufferedSpeechController } from "./lib/buffered-speech";
import { loadRecording, voices } from "./lib/voices";
import { applyTheme, SYSTEM_THEME_QUERY } from "./lib/theme";
import { getTopicName, orderWordsForStudy, TOPICS } from "./lib/topics";
import { getActiveFilm, getFilmProgress, getVisibleFilmCards, percent } from "./lib/films";
import {
  answersByDay,
  countStages,
  dailySuggestions,
  filmReadiness,
  firstMasteryDate,
  historyOf,
  reviewForecast,
  secondsPerCard,
  stageOf,
  STAGES,
  successShare,
  summarizeDay,
} from "./lib/insights";
import type { SpeechController, SpeechStatus } from "./lib/speech";
import type { FilmReadiness, Stage } from "./lib/insights";
import type { AppState, Film, Level, Rating, Settings, Word } from "./lib/types";

const words: Word[] = (vocabulary as Word[]).map((word) => ({
  ...word,
  topic: (topicAssignments as Record<string, string>)[word.id],
}));
const isDesktop = window.location.protocol === "oxford:";
// Films may share a new word; it is one card with one progress.
const filmCards = [...new Map(films.flatMap((film) => film.cards).map((word) => [word.id, word])).values()];
const allCards = [...words, ...filmCards];
const cardsById = new Map(allCards.map((word) => [word.id, word]));
// Film cards stay valid in saved progress even while their mode is off.
const validIds = new Set(allCards.map((word) => word.id));
const filmTitles = new Map(films.map((film) => [film.id, film.title]));
const levels: Level[] = ["A1", "A2", "B1", "B2"];
const studyWords = orderWordsForStudy(words);
const levelNames = {
  A1: "Первые шаги",
  A2: "Уверенная база",
  B1: "Больше свободы",
  B2: "Новые горизонты",
};
const ratingLabels: Record<Rating, string> = {
  again: "Не помню",
  hard: "Сложно",
  good: "Помню",
  easy: "Легко",
};
const ratings: Rating[] = ["again", "hard", "good", "easy"];
const stageNames: Record<Stage, string> = {
  new: "Новые",
  learning: "Учу",
  familiar: "Знакомые",
  confident: "Уверенно",
  mastered: "Закреплено",
};
const stageNotes: Record<Stage, string> = {
  new: "ещё не открывали",
  learning: "интервал меньше дня",
  familiar: "1–6 дней",
  confident: "7–20 дней",
  mastered: "от 21 дня",
};
/** Filled segments of the four-step memory meter. */
const stageLevel: Record<Stage, number> = { new: 0, learning: 1, familiar: 2, confident: 3, mastered: 4 };
const weekdays = ["пн", "вт", "ср", "чт", "пт", "сб", "вс"];
type Page = "study" | "library" | "stats" | "settings";
const pageNames = {
  study: "Практика",
  library: "Словарь",
  stats: "Прогресс",
  settings: "Настройки",
};
const PAGE_SIZE = 30;
function quantity(n: number, one: string, few: string, many: string) {
  return n % 10 === 1 && n % 100 !== 11
    ? one
    : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14)
      ? few
      : many;
}
function intervalLabel(days: number) {
  if (days < 1 / 24) return `${Math.max(1, Math.round(days * 1440))} мин`;
  if (days < 1) return `${Math.round(days * 24)} ч`;
  return `${Math.round(days)} ${quantity(Math.round(days), "день", "дня", "дней")}`;
}
function dateLabel(time: number) {
  return new Date(time).toLocaleDateString("ru-RU", {
    day: "numeric",
    month: "long",
  });
}
function shortDate(time: number) {
  return new Date(time).toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
}
function momentLabel(time: number, now: number) {
  const days = Math.round((new Date(time).setHours(0, 0, 0, 0) - new Date(now).setHours(0, 0, 0, 0)) / 86_400_000);
  const clock = new Date(time).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  return `${days <= 0 ? "сегодня" : days === 1 ? "завтра" : shortDate(time)} в ${clock}`;
}
/** Film cards have no CEFR level: they show the film or the film's term label instead. */
function badgeOf(word: Word) {
  if (word.level) return word.level;
  const title = filmTitles.get(word.film ?? "") ?? "";
  return word.kind === "term" ? filmTermLabels[word.film ?? ""] ?? `Термин: ${title}` : title;
}
function collectionOf(word: Word) {
  return word.film ? filmTitles.get(word.film) ?? "" : getTopicName(word.topic);
}
function headword(word: Word) {
  return word.word.split(",")[0].replace(/\s*\([^)]*\)/g, "").trim();
}
function dictionaryUrl(word: Word) {
  return `https://dictionary.cambridge.org/dictionary/english-russian/${encodeURIComponent(headword(word))}`;
}
/** Splits the example around the card's word and its inflections; null when the word is not found. */
function exampleParts(word: Word): [string, string, string] | null {
  if (!word.example) return null;
  const base = headword(word).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const stems = [base, ...(base.length >= 4 && !base.includes(" ") ? [base.slice(0, -1)] : [])];
  for (const stem of stems) {
    const match = new RegExp(`\\b${stem}\\w*`, "i").exec(word.example);
    if (match) return [word.example.slice(0, match.index), match[0], word.example.slice(match.index + match[0].length)];
  }
  return null;
}
function initialState(): {
  state: AppState;
  error: string;
  raw: string | null;
} {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
    return { state: readState(localStorage, validIds), error: "", raw };
  } catch (error) {
    return {
      state: defaultState(),
      raw,
      error: `Не удалось прочитать прогресс. Сохранённые данные не перезаписаны. ${error instanceof Error ? error.message : ""}`,
    };
  }
}

function MemoryMeter({ stage }: { stage: Stage }) {
  return (
    <span className={`memory memory-${stageLevel[stage]}`} title={stageNames[stage]}>
      <i />
      <i />
      <i />
      <i />
    </span>
  );
}

function StageBar({ counts, total }: { counts: Partial<Record<Stage, number>>; total: number }) {
  return (
    <span className="stage-bar">
      {[...STAGES].reverse().map((stage) =>
        counts[stage] ? (
          <i
            key={stage}
            className={`stage-${stage}`}
            style={{ width: `${(counts[stage]! / Math.max(1, total)) * 100}%` }}
          />
        ) : null,
      )}
    </span>
  );
}

function Poster({ film, className = "" }: { film: Film; className?: string }) {
  const src = filmPosters[film.id];
  return src ? (
    <img className={`poster ${className}`} src={src} alt="" />
  ) : (
    <span className={`poster poster-empty ${className}`}>
      <Clapperboard size={18} />
    </span>
  );
}

export default function App() {
  const [initial] = useState(initialState);
  const [state, setState] = useState(initial.state);
  const [storageError, setStorageError] = useState(initial.error);
  const [page, setPage] = useState<Page>("study");
  const [now, setNow] = useState(Date.now());
  const [revealed, setRevealed] = useState(false);
  const [hint, setHint] = useState(false);
  const [focusMode, setFocusMode] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [undoState, setUndoState] = useState<AppState | null>(null);
  const [drill, setDrill] = useState<{ ids: string[]; total: number; revealed: boolean } | null>(null);
  const [toast, setToast] = useState("");
  const [speechState, setSpeechState] = useState<{ status: SpeechStatus; text: string }>({ status: "idle", text: "" });
  const [query, setQuery] = useState("");
  const [libraryLevel, setLibraryLevel] = useState("all");
  const [libraryStage, setLibraryStage] = useState("all");
  const [libraryTopic, setLibraryTopic] = useState("all");
  const [libraryPage, setLibraryPage] = useState(0);
  const [detail, setDetail] = useState<Word | null>(null);
  const [pendingImport, setPendingImport] = useState<AppState | null>(null);
  const [filmMenu, setFilmMenu] = useState<"chip" | "card" | null>(null);
  const [filmPicker, setFilmPicker] = useState(false);
  const [filmQuery, setFilmQuery] = useState("");
  const [filmFilter, setFilmFilter] = useState<"all" | "started">("all");
  const [filmSort, setFilmSort] = useState<"ready" | "title">("ready");
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const storedRaw = useRef(initial.raw);
  const corruptStorage = useRef(!!initial.error);
  const savingRef = useRef(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const speech = useRef<(SpeechController & { prepare?: (text: string) => void }) | null>(null);
  const queue = useMemo(
    () => getStudyQueue(studyWords, state, now, films),
    [state, now],
  );
  const drillWord = drill ? cardsById.get(drill.ids[0]) : undefined;
  const current = drillWord ?? queue.find((word) => word.id === activeId) ?? queue[0];
  const isRevealed = drill ? drill.revealed : revealed;
  const stats = useMemo(() => getStats(words, state, now, films), [state, now]);
  const reverse = state.settings.direction === "ru-en";
  const activeFilm = getActiveFilm(films, state);
  const filmProgress = useMemo(
    () => (activeFilm ? getFilmProgress(activeFilm, state) : null),
    [activeFilm, state],
  );
  const readiness = useMemo(() => filmReadiness(films, state), [state]);
  const activeReadiness = readiness.find((item) => item.film.id === activeFilm?.id);
  // Without a mode the card keeps the last film studied, shown as paused.
  const shownFilm =
    activeReadiness ??
    readiness.filter((item) => item.lastStudied > 0).sort((a, b) => b.lastStudied - a.lastStudied)[0];
  const suggestions = dailySuggestions(readiness, activeFilm?.id ?? null, now);
  const day = useMemo(() => summarizeDay(state, now), [state, now]);
  const availableWords = useMemo(() => getAvailableWords(words, state, films), [state]);
  const forecast = useMemo(() => reviewForecast(availableWords, state, now), [availableWords, state, now]);
  const cardSeconds = useMemo(() => secondsPerCard(state.reviews), [state.reviews]);
  const todayKey = localDayKey(now);
  const todayNew = day.newWords;
  const reviewsDone = new Set(
    state.reviews
      .filter((review) => !review.isNew && review.at <= now && localDayKey(review.at) === todayKey)
      .map((review) => review.wordId),
  ).size;
  const dailyNewLimit = getDailyNewLimit(state, now);
  const extraWordsCount = Math.min(10, getNewWords(studyWords, state, films).length);
  const remainingMinutes = Math.max(1, Math.ceil(((stats.due + stats.newAvailable) * cardSeconds) / 60));
  const sessionTotal = day.answers + stats.due + stats.newAvailable;
  const share = (n: number) => `${(n / Math.max(1, sessionTotal)) * 100}%`;

  useLayoutEffect(() => {
    const media = window.matchMedia(SYSTEM_THEME_QUERY);
    const refreshTheme = () => applyTheme(state.settings.theme, media.matches);
    let disposed = false;
    refreshTheme();
    media.addEventListener("change", refreshTheme);
    // Electron also needs the preference for its native window buttons and menus.
    window.oxfordTheme?.setSource(state.settings.theme).catch(() => {
      if (!disposed) setToast("Не удалось обновить тему окна. Перезапустите приложение.");
    });
    return () => {
      disposed = true;
      media.removeEventListener("change", refreshTheme);
    };
  }, [state.settings.theme]);

  useEffect(() => {
    const callbacks = {
      onError: setToast,
      onStatus: (status: SpeechStatus, text: string) => setSpeechState({ status, text }),
    };
    if (isDesktop && !window.oxfordAudio) return;
    if (!isDesktop && (!("speechSynthesis" in window) || !("SpeechSynthesisUtterance" in window))) return;
    const controller = isDesktop
      ? createBufferedSpeechController({
          // Bundled recordings of the chosen voice; words without one use the Windows voice.
          load: (text) => loadRecording(state.settings.voice, text),
          prepare: (text) => window.oxfordAudio!.prepare(text),
          ...callbacks,
        })
      : createSpeechController({
          synthesis: window.speechSynthesis,
          createUtterance: (text) => new SpeechSynthesisUtterance(text),
          ...callbacks,
        });
    speech.current = controller;
    const stopWhenHidden = () => {
      if (document.hidden) controller.stop();
    };
    const stop = () => controller.stop();
    document.addEventListener("visibilitychange", stopWhenHidden);
    window.addEventListener("pagehide", stop);
    return () => {
      speech.current = null;
      document.removeEventListener("visibilitychange", stopWhenHidden);
      window.removeEventListener("pagehide", stop);
      controller.dispose();
    };
  }, [state.settings.voice]);
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    const refresh = () => setNow(Date.now());
    const sync = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY || event.key === null)
        adoptStored(event.newValue);
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("storage", sync);
    };
  }, []);
  useEffect(() => {
    const nextId = drill ? null : current?.id ?? null;
    if (!drill && activeId !== nextId) {
      setRevealed(false);
      setActiveId(nextId);
    }
  }, [current?.id, activeId, !!drill]);
  useEffect(() => {
    setHint(false);
  }, [current?.id, isRevealed]);
  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(""), 6000);
    return () => clearTimeout(id);
  }, [toast]);
  useEffect(() => {
    if (pendingImport || filmPicker) dialogRef.current?.showModal();
    else dialogRef.current?.close();
  }, [pendingImport, filmPicker]);
  useEffect(() => {
    setLibraryPage(0);
  }, [query, libraryLevel, libraryStage, libraryTopic]);
  useEffect(() => {
    if (!filmMenu) return;
    const close = (event: MouseEvent) => {
      if (!(event.target as HTMLElement).closest(".film-menu, .film-menu-trigger")) setFilmMenu(null);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [filmMenu]);
  useEffect(() => {
    setFilmMenu(null);
    if (page !== "study") setFocusMode(false);
  }, [page]);
  useEffect(() => {
    speech.current?.stop();
  }, [current?.id, page, reverse, detail?.id, !!pendingImport, state.settings.autoSpeak]);
  useEffect(() => {
    // Preparation is silent, including on the hidden side of reverse cards.
    const text = page === "library" ? detail?.word : page === "study" ? current?.word : undefined;
    if (text && !pendingImport) speech.current?.prepare?.(text);
  }, [current?.id, page, detail?.id, !!pendingImport]);
  useEffect(() => {
    if (
      page === "study" &&
      current &&
      (drill || current.id === activeId) &&
      !pendingImport &&
      !document.hidden &&
      state.settings.autoSpeak &&
      (!reverse || isRevealed)
    )
      speak(current.word);
  }, [
    current?.id,
    activeId,
    page,
    !!pendingImport,
    state.settings.autoSpeak,
    reverse,
    reverse && isRevealed,
  ]);

  function adoptStored(raw: string | null) {
    storedRaw.current = raw;
    try {
      const next = raw === null ? defaultState() : parseBackup(raw, validIds);
      setState(next);
      corruptStorage.current = false;
      setStorageError("");
      setToast("Прогресс обновлён из другой вкладки");
    } catch (error) {
      corruptStorage.current = true;
      setStorageError(
        error instanceof Error
          ? error.message
          : "Не удалось прочитать прогресс",
      );
    }
    setUndoState(null);
    setActiveId(null);
    setRevealed(false);
    setNow(Date.now());
  }
  async function save(next: AppState, recovery = false): Promise<boolean> {
    if (savingRef.current) return false;
    if (corruptStorage.current && !recovery) {
      setToast(
        "Откройте настройки: сохраните исходные данные и восстановите копию или начните заново.",
      );
      return false;
    }
    const expectedRaw = storedRaw.current;
    savingRef.current = true;
    setSaving(true);
    const perform = () => {
      const latestRaw = localStorage.getItem(STORAGE_KEY);
      if (!recovery && latestRaw !== expectedRaw) {
        adoptStored(latestRaw);
        setToast("Прогресс изменился в другой вкладке. Повторите действие.");
        return false;
      }
      writeState(next);
      storedRaw.current = JSON.stringify(next);
      corruptStorage.current = false;
      setState(next);
      setStorageError("");
      return true;
    };
    try {
      return navigator.locks
        ? await navigator.locks.request("oxford-cards-write", perform)
        : perform();
    } catch (error) {
      setStorageError(
        error instanceof Error
          ? error.message
          : "Не удалось сохранить прогресс",
      );
      return false;
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }
  function speak(text: string) {
    if (!speech.current) {
      setToast("Озвучивание недоступно в этом браузере.");
      return;
    }
    speech.current.speak(text);
  }
  function reveal() {
    if (drill) setDrill({ ...drill, revealed: true });
    else setRevealed(true);
  }
  async function rate(rating: Rating) {
    if (!current || !revealed || drill) return;
    const at = Date.now();
    const next: AppState = {
      ...state,
      cards: {
        ...state.cards,
        [current.id]: scheduleCard(state.cards[current.id], rating, at),
      },
      reviews: [
        ...state.reviews,
        { wordId: current.id, at, rating, isNew: !state.cards[current.id] },
      ],
    };
    if (await save(next)) {
      setUndoState(state);
      setRevealed(false);
      setActiveId(null);
      setNow(at);
    }
  }
  /** Extra round over today's hard words; answers here do not change the schedule. */
  function answerDrill(remembered: boolean) {
    if (!drill?.revealed) return;
    const [first, ...rest] = drill.ids;
    const ids = remembered ? rest : [...rest, first];
    if (!ids.length) {
      setDrill(null);
      setToast("Трудные слова пройдены. Расписание повторений не изменилось.");
      return;
    }
    setDrill({ ...drill, ids, revealed: false });
  }
  async function undo() {
    if (undoState && (await save({ ...undoState, settings: state.settings, dailyExtra: state.dailyExtra }))) {
      setUndoState(null);
      setActiveId(null);
      setRevealed(false);
      setNow(Date.now());
      setToast("Последняя оценка отменена");
    }
  }
  async function studyMoreToday() {
    const at = Date.now();
    // Refresh first if a repetition became due or a new calendar day started.
    if (getStudyQueue(studyWords, state, at, films).length > 0) {
      setNow(at);
      return;
    }
    if (!extraWordsCount) return;
    if (await save(addExtraNewWords(state, extraWordsCount, at))) {
      setActiveId(null);
      setRevealed(false);
      setNow(at);
    }
  }
  function updateSettings(update: Partial<Settings>) {
    save({ ...state, settings: { ...state.settings, ...update } });
  }
  function selectFilm(film: string) {
    setActiveId(null);
    setRevealed(false);
    setFilmMenu(null);
    setFilmPicker(false);
    updateSettings({ film: film || null });
  }
  function openFilmPicker() {
    setFilmMenu(null);
    setFilmQuery("");
    setFilmPicker(true);
  }
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape" && filmMenu) {
        setFilmMenu(null);
        return;
      }
      if (
        page !== "study" ||
        pendingImport ||
        filmPicker ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        event.repeat
      )
        return;
      if (
        (event.target as HTMLElement).closest(
          "input,select,textarea,[contenteditable]",
        )
      )
        return;
      if (event.key === "Escape" && focusMode) {
        setFocusMode(false);
        return;
      }
      if (
        event.code === "Space" &&
        current &&
        !isRevealed &&
        !(event.target as HTMLElement).closest("button,a")
      ) {
        event.preventDefault();
        reveal();
      }
      if (event.code === "KeyE" && current && !isRevealed && hintParts) {
        event.preventDefault();
        setHint(true);
      }
      if (isRevealed && drill && ["1", "2"].includes(event.key)) {
        event.preventDefault();
        answerDrill(event.key === "2");
      }
      if (isRevealed && !drill && ["1", "2", "3", "4"].includes(event.key)) {
        event.preventDefault();
        rate(ratings[Number(event.key) - 1]);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // New film cards join the dictionary only while their mode is on.
  const libraryWords = useMemo(() => {
    const filmCards = getVisibleFilmCards(films, state);
    return filmCards.length
      ? [...words, ...filmCards].sort((a, b) => a.word.localeCompare(b.word, "en"))
      : words;
  }, [activeFilm]);
  const levelFilter = libraryLevel === "film" && !activeFilm ? "all" : libraryLevel;
  const filteredWords = useMemo(
    () =>
      libraryWords.filter((word) => {
        const progress = state.cards[word.id];
        const matchesStage =
          libraryStage === "all" ||
          (libraryStage === "due" ? !!progress && progress.due <= now : stageOf(progress) === libraryStage);
        const matchesTopic =
          libraryTopic === "all" || (libraryTopic === "film" ? !!word.film : word.topic === libraryTopic);
        return (
          matchesStage &&
          matchesTopic &&
          (levelFilter === "all" ||
            word.level === levelFilter ||
            (levelFilter === "film" && !!word.film)) &&
          `${word.word} ${word.translation}`
            .toLocaleLowerCase()
            .includes(query.trim().toLocaleLowerCase())
        );
      }),
    [libraryWords, query, levelFilter, libraryStage, libraryTopic, state.cards, now],
  );
  const pageCount = Math.max(1, Math.ceil(filteredWords.length / PAGE_SIZE));
  const safePage = Math.min(libraryPage, pageCount - 1);
  const nextDue = availableWords
    .map((word) => state.cards[word.id])
    .filter((card) => card?.due > now)
    .sort((a, b) => a.due - b.due)[0]?.due;
  const dayCounts = useMemo(() => answersByDay(state.reviews), [state.reviews]);
  const weekStart = new Date(now);
  weekStart.setHours(12, 0, 0, 0);
  weekStart.setDate(weekStart.getDate() - ((weekStart.getDay() + 6) % 7));
  const thisWeek = weekdays.map((name, index) => {
    const date = new Date(weekStart);
    date.setDate(weekStart.getDate() + index);
    const key = localDayKey(date.getTime());
    return { name, active: dayCounts.has(key), today: key === todayKey };
  });
  const oxfordStarted = words.filter((word) => state.cards[word.id]).length;
  const levelTotals = levels.map((level) => {
    const levelWords = words.filter((word) => word.level === level);
    return {
      level,
      words: levelWords,
      started: levelWords.filter((word) => state.cards[word.id]).length,
    };
  });
  const hintParts = current ? exampleParts(current) : null;
  const ratingIntervals = current && !drill
    ? ratings.map((rating) => intervalLabel(scheduleCard(state.cards[current.id], rating, now).interval))
    : [];
  const currentHistory = current ? historyOf(state, current.id).slice(-4) : [];

  function downloadBackup() {
    const raw = corruptStorage.current
      ? storedRaw.current
      : JSON.stringify(state, null, 2);
    if (raw === null) {
      setToast("Сохранённых данных пока нет");
      return;
    }
    const blob = new Blob([raw], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `oxford-cards-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setToast("Резервная копия скачана");
  }
  async function importBackup(file: File | undefined) {
    if (!file) return;
    try {
      setResetting(false);
      if (file.size > 20 * 1024 * 1024) throw new Error("Файл больше 20 МБ");
      setPendingImport(parseBackup(await file.text(), validIds));
    } catch (error) {
      setToast(
        `Не удалось импортировать: ${error instanceof Error ? error.message : "неверный файл"}`,
      );
    }
    if (importRef.current) importRef.current.value = "";
  }
  async function confirmImport() {
    if (!pendingImport) return;
    if (await save(pendingImport, true)) {
      setPendingImport(null);
      setUndoState(null);
      setActiveId(null);
      setRevealed(false);
      setToast(
        resetting ? "Можно начать обучение заново" : "Прогресс восстановлен",
      );
      setResetting(false);
    }
  }
  function nextReviewLabel(word: Word) {
    const card = state.cards[word.id];
    if (!card) return "новое";
    return card.due <= now ? "сегодня" : shortDate(card.due);
  }

  function renderExample(word: Word, masked: boolean) {
    const parts = exampleParts(word);
    if (!parts) return word.example;
    return (
      <>
        {parts[0]}
        {masked ? <span className="example-gap">…</span> : <mark>{parts[1]}</mark>}
        {parts[2]}
      </>
    );
  }

  function renderFilmMenu(anchor: "chip" | "card") {
    if (filmMenu !== anchor) return null;
    const row = (item: FilmReadiness, note: string, selected = false) => (
      <button
        key={item.film.id}
        className={`menu-item${selected ? " selected" : ""}`}
        disabled={saving}
        onClick={() => (selected ? setFilmMenu(null) : selectFilm(item.film.id))}
      >
        <Poster film={item.film} className="menu-thumb" />
        <span>
          <strong>{item.film.title}</strong>
          <small>{note}</small>
        </span>
        {selected && <Check size={16} />}
      </button>
    );
    return (
      <div className={`film-menu film-menu-${anchor}`} role="menu">
        <h6>СЕЙЧАС</h6>
        {activeReadiness ? (
          row(activeReadiness, `${activeReadiness.words}% слов · ${activeReadiness.speech}% речи`, true)
        ) : (
          <button className="menu-item selected" onClick={() => setFilmMenu(null)}>
            <span className="menu-thumb menu-icon">
              <Layers size={15} />
            </span>
            <span>
              <strong>Без мода</strong>
              <small>Oxford 3000 по уровням и темам</small>
            </span>
            <Check size={16} />
          </button>
        )}
        {suggestions.length > 0 && (
          <>
            <h6>
              БЛИЖЕ К ПРОСМОТРУ
              {readiness.length - (activeFilm ? 1 : 0) > suggestions.length && " · СМЕНЯТСЯ ЗАВТРА"}
            </h6>
            {suggestions.map((item) =>
              row(item, `понятно ${item.speech}% речи · ${item.remaining} ${quantity(item.remaining, "слово", "слова", "слов")} выучить`),
            )}
          </>
        )}
        <hr />
        {activeFilm && (
          <button className="menu-item" disabled={saving} onClick={() => selectFilm("")}>
            <span className="menu-thumb menu-icon">
              <Layers size={15} />
            </span>
            <span>
              <strong>Без мода</strong>
              <small>Oxford 3000 по уровням и темам</small>
            </span>
          </button>
        )}
        <button className="menu-item" onClick={openFilmPicker}>
          <span className="menu-thumb menu-icon">
            <Search size={15} />
          </span>
          <span>
            <strong>Другие фильмы</strong>
            <small>
              {films.length} {quantity(films.length, "фильм", "фильма", "фильмов")}, поиск и сортировка
            </small>
          </span>
          <ArrowRight size={15} />
        </button>
      </div>
    );
  }

  function renderSessionBar() {
    if (drill) {
      const done = drill.total - drill.ids.length;
      return (
        <div className="session">
          <div className="session-row">
            <h1>Трудные слова</h1>
            <span className="session-left">
              {done} из {drill.total} · расписание не меняется
            </span>
            <div className="session-tools">
              <button className="chip" onClick={() => setDrill(null)}>
                <X size={15} />
                Закончить
              </button>
            </div>
          </div>
          <div className="session-bar">
            <i className="seg-done" style={{ width: `${(done / drill.total) * 100}%` }} />
          </div>
        </div>
      );
    }
    const left = stats.due + stats.newAvailable;
    return (
      <div className="session">
        <div className="session-row">
          <h1>Практика</h1>
          <span className="session-left">
            {left
              ? `осталось ${left} ${quantity(left, "карточка", "карточки", "карточек")} · ≈ ${remainingMinutes} мин`
              : "на сегодня всё"}
          </span>
          <div className="session-tools">
            <span className="menu-anchor">
              <button
                className={`chip film-menu-trigger${activeFilm ? " on" : ""}${filmMenu === "chip" ? " pressed" : ""}`}
                aria-expanded={filmMenu === "chip"}
                onClick={() => setFilmMenu(filmMenu === "chip" ? null : "chip")}
              >
                {activeFilm ? <Poster film={activeFilm} className="chip-poster" /> : <Clapperboard size={15} />}
                {activeFilm && activeReadiness ? `${activeFilm.title} · ${activeReadiness.words}%` : "Без мода"}
                <ChevronDown size={14} />
              </button>
              {renderFilmMenu("chip")}
            </span>
            <button
              className={`chip icon${state.settings.autoSpeak ? " on" : ""}`}
              aria-pressed={state.settings.autoSpeak}
              aria-label="Произносить автоматически"
              title={state.settings.autoSpeak ? "Автоозвучка включена" : "Автоозвучка выключена"}
              disabled={saving}
              onClick={() => updateSettings({ autoSpeak: !state.settings.autoSpeak })}
            >
              {state.settings.autoSpeak ? <Volume2 size={16} /> : <VolumeX size={16} />}
            </button>
            <button
              className={`chip icon${focusMode ? " on" : ""}`}
              aria-pressed={focusMode}
              aria-label="Режим фокуса"
              title={focusMode ? "Выйти из режима фокуса (Esc)" : "Режим фокуса: только карточка"}
              onClick={() => setFocusMode(!focusMode)}
            >
              {focusMode ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
            </button>
          </div>
        </div>
        <div
          className="session-bar"
          role="img"
          aria-label={`Пройдено ${day.answers}, повторений осталось ${stats.due}, новых осталось ${stats.newAvailable}`}
        >
          {day.answers > 0 && <i className="seg-done" style={{ width: share(day.answers) }} />}
          {stats.due > 0 && <i className="seg-review" style={{ width: share(stats.due) }} />}
          {stats.newAvailable > 0 && <i className="seg-new" style={{ width: share(stats.newAvailable) }} />}
        </div>
        <div className="session-legend">
          <span>
            <b className="seg-done" />
            Пройдено <strong>{day.answers}</strong>
          </span>
          <span>
            <b className="seg-review" />
            Повторения <strong>{stats.due}</strong>
          </span>
          <span>
            <b className="seg-new" />
            Новые <strong>{stats.newAvailable}</strong>
          </span>
        </div>
      </div>
    );
  }

  function renderCard(word: Word) {
    const known = state.cards[word.id];
    const canHint = !isRevealed && !!exampleParts(word);
    return (
      <>
        <div className={`flashcard panel${isRevealed ? " is-revealed" : ""}`} key={word.id}>
          <div className="card-top">
            <span className={`tag${word.film ? " tag-film" : ""}`} title={word.film ? undefined : `Тема: ${getTopicName(word.topic)}`}>
              {collectionOf(word)}
            </span>
            <span className="tag tag-plain">{known ? "Повторение" : "Новое слово"}</span>
            <span className={`tag tag-level${word.film ? " tag-level-film" : ""}`}>{badgeOf(word)}</span>
          </div>
          <div className="card-body">
            {!isRevealed && <span className="prompt-label">{reverse ? "КАК ЭТО ПО-АНГЛИЙСКИ?" : "ВСПОМНИТЕ ПЕРЕВОД"}</span>}
            <h2 className={`card-word${reverse && !isRevealed ? " translation-prompt" : ""}${isRevealed ? " is-small" : ""}`}>
              {reverse && !isRevealed ? word.translation : word.word}
            </h2>
            <div className="word-meta">
              <span>{word.pos}</span>
              {(!reverse || isRevealed) && (
                <button
                  className={`audio-button${speechState.status !== "idle" && speechState.text === word.word ? " is-speaking" : ""}`}
                  onClick={() => speak(word.word)}
                  aria-label={`Произнести ${word.word}`}
                  title="Произнести с начала"
                  aria-busy={speechState.status === "loading" && speechState.text === word.word}
                >
                  <AudioLines size={19} />
                </button>
              )}
            </div>
            {hint && !isRevealed && word.example && (
              <p className="example hint-example">{renderExample(word, reverse)}</p>
            )}
            {isRevealed && (
              <div className="answer" aria-live="polite">
                <h3>{reverse ? word.word : word.translation}</h3>
                {word.note && <p className="term-note">{word.note}</p>}
                {word.example && <p className="example">{renderExample(word, false)}</p>}
                {word.exampleTranslation && <p className="example-translation">{word.exampleTranslation}</p>}
                <div className="answer-links">
                  {!drill && currentHistory.length > 0 && (
                    <span className="history">
                      Раньше:
                      {currentHistory.map((entry) => (
                        <span key={entry.at} className={`pill pill-${entry.rating}`} title={dateLabel(entry.at)}>
                          {ratingLabels[entry.rating]}
                        </span>
                      ))}
                    </span>
                  )}
                  <a href={dictionaryUrl(word)} target="_blank" rel="noreferrer">
                    Cambridge
                    <ExternalLink size={12} />
                  </a>
                </div>
              </div>
            )}
          </div>
          <div className="card-foot">
            {canHint && !hint ? (
              <button className="hint-button" onClick={() => setHint(true)}>
                <Lightbulb size={15} />
                Не вспоминается? Покажите пример
                <kbd>E</kbd>
              </button>
            ) : (
              <span>{isRevealed ? "Насколько легко вспомнили?" : "Не спешите. Попробуйте вспомнить."}</span>
            )}
            <span>{reverse ? "Русский → английский" : "Английский → русский"}</span>
          </div>
        </div>
        {!isRevealed ? (
          <button className="reveal-button" onClick={reveal}>
            Показать перевод
            <ArrowRight size={18} />
            <kbd>Пробел</kbd>
          </button>
        ) : drill ? (
          <div className="rating-grid drill" aria-label="Вспомнили?">
            <button className="rating rating-again" onClick={() => answerDrill(false)}>
              <span>Ещё раз</span>
              <strong>в конец списка</strong>
              <kbd>1</kbd>
            </button>
            <button className="rating rating-good" onClick={() => answerDrill(true)}>
              <span>Помню</span>
              <strong>убрать из списка</strong>
              <kbd>2</kbd>
            </button>
          </div>
        ) : (
          <div className="rating-grid" aria-label="Оцените ответ">
            {ratings.map((rating, index) => (
              <button
                key={rating}
                className={`rating rating-${rating}`}
                disabled={saving}
                onClick={() => rate(rating)}
              >
                <span>{ratingLabels[rating]}</span>
                <strong>{ratingIntervals[index]}</strong>
                <kbd>{index + 1}</kbd>
              </button>
            ))}
          </div>
        )}
        <div className="practice-footer">
          <span>
            {isRevealed
              ? drill
                ? "Клавиши 1 и 2"
                : "Оцените ответ клавишами 1–4"
              : "Сначала вспомните сами, затем откройте ответ"}
          </span>
          {!drill && (
            <button disabled={!undoState || saving} onClick={undo}>
              <RotateCcw size={14} />
              Отменить
            </button>
          )}
        </div>
      </>
    );
  }

  function renderDone() {
    if (stats.started === 0 && day.answers === 0) {
      return (
        <div className="panel done-panel">
          <div className="done-top">
            <span className="done-icon">
              <BookOpen size={26} />
            </span>
            <div>
              <h2>Выберите слова для старта</h2>
              <p>Включите уровни или новые слова в настройках, чтобы начать.</p>
            </div>
          </div>
          <div className="done-actions">
            <button className="primary-button" onClick={() => setPage("settings")}>
              Открыть настройки
              <ArrowRight size={16} />
            </button>
          </div>
        </div>
      );
    }
    const note =
      extraWordsCount === 0
        ? "Вы уже познакомились со всеми словами выбранных уровней."
        : dailyNewLimit === 0
          ? "Новые слова отключены в настройках."
          : "Все повторения сделаны, дневная цель по новым словам выполнена.";
    return (
      <div className="panel done-panel">
        <div className="done-top">
          <span className="done-icon">
            <Check size={26} />
          </span>
          <div>
            <h2>Готово на сегодня</h2>
            <p>{note}</p>
          </div>
        </div>
        {day.answers > 0 && (
          <div className="kpis">
            <div>
              <span>Карточек</span>
              <strong>{day.answers}</strong>
            </div>
            <div>
              <span>Время</span>
              <strong>{day.minutes} мин</strong>
            </div>
            <div>
              <span>Вспомнили</span>
              <strong>{day.recalled}%</strong>
            </div>
            <div>
              <span>Новых слов</span>
              <strong>+{day.newWords}</strong>
            </div>
          </div>
        )}
        {day.hardWords.length > 0 && (
          <div className="hard-list">
            <h4>
              Трудные сегодня{" "}
              <span>
                · {day.hardWords.length} {quantity(day.hardWords.length, "слово", "слова", "слов")}
              </span>
            </h4>
            {day.hardWords.slice(0, 6).map((item) => {
              const word = cardsById.get(item.wordId);
              if (!word) return null;
              return (
                <div className="hard-row" key={item.wordId}>
                  <span className="hard-word">{word.word}</span>
                  <span className="hard-translation">{word.translation}</span>
                  <span className={`pill ${item.again ? "pill-again" : "pill-hard"}`}>
                    {item.again ? `Не помню${item.again > 1 ? ` ×${item.again}` : ""}` : "Сложно"}
                  </span>
                </div>
              );
            })}
            {day.hardWords.length > 6 && (
              <p className="hard-more">
                и ещё {day.hardWords.length - 6} {quantity(day.hardWords.length - 6, "слово", "слова", "слов")}
              </p>
            )}
          </div>
        )}
        <div className="done-actions">
          {nextDue && (
            <p className="next-line">
              <Clock3 size={15} />
              Следующее повторение — <strong>{momentLabel(nextDue, now)}</strong>
              {forecast[1] > 0 && (
                <>
                  , всего завтра <strong>{forecast[1]}</strong>
                </>
              )}
            </p>
          )}
          <div className="done-buttons">
            {extraWordsCount > 0 && (
              <button className="primary-button" disabled={saving || !!storageError} onClick={studyMoreToday}>
                Ещё {extraWordsCount} {quantity(extraWordsCount, "слово", "слова", "слов")} на сегодня
                <ArrowRight size={16} />
              </button>
            )}
            {day.hardWords.length > 0 && (
              <button
                className="secondary-button"
                onClick={() => {
                  const ids = day.hardWords.map((item) => item.wordId).filter((id) => cardsById.has(id));
                  setDrill({ ids, total: ids.length, revealed: false });
                }}
              >
                <Repeat2 size={16} />
                Трудные ещё раз
              </button>
            )}
            {undoState && (
              <button className="text-button" disabled={saving} onClick={undo}>
                <RotateCcw size={15} />
                Отменить оценку
              </button>
            )}
          </div>
          {extraWordsCount > 0 && <p className="extra-today-note">Дополнительные слова — только на сегодня, дневной лимит не изменится.</p>}
        </div>
      </div>
    );
  }

  function renderFilmCard() {
    return (
      <div className="menu-anchor">
        {shownFilm ? (
          <div className="panel film-card">
            <Poster film={shownFilm.film} className="film-art" />
            <div className="film-body">
              <div className="film-title">
                <strong>
                  {shownFilm.film.title}
                  {!activeFilm && <small>на паузе</small>}
                </strong>
                <button
                  className={`link-button film-menu-trigger${filmMenu === "card" ? " pressed" : ""}`}
                  aria-expanded={filmMenu === "card"}
                  onClick={() => setFilmMenu(filmMenu === "card" ? null : "card")}
                >
                  Выбрать фильм
                  <ChevronDown size={13} />
                </button>
              </div>
              <span className="film-numbers">
                Изучено {shownFilm.words}% слов · понятно {shownFilm.speech}% речи
              </span>
              <div className="progress-track film-track" title={`Изучено ${shownFilm.words}% слов`}>
                <div style={{ width: `${shownFilm.words}%` }} />
              </div>
            </div>
          </div>
        ) : (
          <div className="panel film-card film-card-empty">
            <span className="film-empty-icon">
              <Clapperboard size={20} />
            </span>
            <div className="film-body">
              <div className="film-title">
                <strong>Мод фильма</strong>
                <button
                  className={`link-button film-menu-trigger${filmMenu === "card" ? " pressed" : ""}`}
                  aria-expanded={filmMenu === "card"}
                  onClick={() => setFilmMenu(filmMenu === "card" ? null : "card")}
                >
                  Выбрать фильм
                  <ChevronDown size={13} />
                </button>
              </div>
              <span className="film-numbers">Слова выбранного фильма пойдут первыми</span>
            </div>
          </div>
        )}
        {renderFilmMenu("card")}
      </div>
    );
  }

  function renderToday() {
    const ring = dailyNewLimit ? Math.min(1, todayNew / dailyNewLimit) : 0;
    const left = Math.max(0, dailyNewLimit - todayNew);
    return (
      <div className="panel today-panel">
        <h4>Сегодня</h4>
        <div className="goal">
          <span className="ring" aria-label={`Новые слова: ${todayNew} из ${dailyNewLimit}`}>
            <svg viewBox="0 0 82 82" aria-hidden="true">
              <circle cx="41" cy="41" r="35" className="ring-track" />
              <circle
                cx="41"
                cy="41"
                r="35"
                className="ring-value"
                strokeDasharray={`${ring * 219.9} 220`}
              />
            </svg>
            {ring >= 1 ? (
              <Check className="ring-check" size={26} />
            ) : (
              <b>
                {todayNew}
                <small>/{dailyNewLimit}</small>
              </b>
            )}
          </span>
          <p>
            <strong>{ring >= 1 ? `${todayNew} из ${dailyNewLimit}` : "Новые слова"}</strong>
            {dailyNewLimit === 0
              ? "отключены — сегодня только повторения"
              : ring >= 1
                ? "цель по новым словам выполнена"
                : activeFilm && stats.newAvailable
                  ? `ещё ${left}, сейчас идут слова «${activeFilm.title}»`
                  : `ещё ${left} на сегодня`}
          </p>
        </div>
        <div className="today-rows">
          <div>
            <span>Повторения</span>
            <strong>
              {reviewsDone} из {reviewsDone + stats.due}
            </strong>
          </div>
          <div>
            <span>Вспомнили сегодня</span>
            <strong>{day.answers ? `${day.recalled}%` : "—"}</strong>
          </div>
        </div>
      </div>
    );
  }

  function renderPractice() {
    return (
      <div className="study-layout">
        <section className="practice-column">
          {renderSessionBar()}
          {current ? renderCard(current) : renderDone()}
        </section>
        <aside className="study-aside">
          {renderToday()}
          {renderFilmCard()}
          <div className="panel tomorrow">
            <CalendarDays size={16} />
            <span>
              Завтра <strong>{forecast[1]}</strong> {quantity(forecast[1], "повторение", "повторения", "повторений")}
            </span>
          </div>
        </aside>
      </div>
    );
  }

  function renderLibrary() {
    const meanings = detail ? libraryWords.filter((word) => word.word === detail.word) : [];
    const detailCard = detail ? state.cards[detail.id] : undefined;
    const detailHistory = detail ? historyOf(state, detail.id) : [];
    return (
      <div className={`library-layout${detail ? " has-detail" : ""}`}>
        <section className="library-main">
          <div className="page-head">
            <h1>Словарь</h1>
            <span>
              {libraryWords.length.toLocaleString("ru-RU")} {quantity(libraryWords.length, "карточка", "карточки", "карточек")}
              {filteredWords.length !== libraryWords.length && ` · найдено ${filteredWords.length.toLocaleString("ru-RU")}`}
            </span>
          </div>
          <label className="search-field">
            <Search size={18} />
            <input
              aria-label="Поиск слова или перевода"
              placeholder="Найти слово или перевод…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            {query && (
              <button aria-label="Очистить поиск" onClick={() => setQuery("")}>
                <X size={16} />
              </button>
            )}
          </label>
          <div className="filters">
            {["all", ...levels, ...(activeFilm ? ["film"] : [])].map((level) => (
              <button
                key={level}
                className={`chip${levelFilter === level ? " on" : ""}`}
                aria-pressed={levelFilter === level}
                onClick={() => setLibraryLevel(level)}
              >
                {level === "all" ? "Все уровни" : level === "film" ? activeFilm?.title : level}
              </button>
            ))}
            <span className="filter-separator" />
            <select aria-label="Стадия памяти" value={libraryStage} onChange={(event) => setLibraryStage(event.target.value)}>
              <option value="all">Стадия: любая</option>
              {STAGES.map((stage) => (
                <option key={stage} value={stage}>
                  {stageNames[stage]}
                </option>
              ))}
              <option value="due">Пора повторить</option>
            </select>
            <select aria-label="Тема" value={libraryTopic} onChange={(event) => setLibraryTopic(event.target.value)}>
              <option value="all">Тема: все</option>
              {TOPICS.map((topic) => (
                <option key={topic.id} value={topic.id}>
                  {topic.name}
                </option>
              ))}
              {activeFilm && <option value="film">Слова «{activeFilm.title}»</option>}
            </select>
          </div>
          <div className="word-table panel">
            <div className="table-head">
              <span>СЛОВО</span>
              <span>ПЕРЕВОД</span>
              <span>УР.</span>
              <span>ПАМЯТЬ</span>
              <span>ПОВТОР</span>
            </div>
            {filteredWords.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE).map((word) => (
              <button
                className={`word-row${detail?.id === word.id ? " selected" : ""}`}
                key={word.id}
                aria-pressed={detail?.id === word.id}
                onClick={() => setDetail(word)}
              >
                <span className="row-word">
                  <strong>{word.word}</strong>
                  <small>{word.pos}</small>
                </span>
                <span className="row-translation">{word.translation}</span>
                <span>
                  <span className={`level-badge${word.film ? " film-badge" : ""}`}>{badgeOf(word)}</span>
                </span>
                <MemoryMeter stage={stageOf(state.cards[word.id])} />
                <span className="row-next">{nextReviewLabel(word)}</span>
              </button>
            ))}
            {filteredWords.length === 0 && (
              <div className="no-results">
                <Search size={28} />
                <h3>Такого слова не нашлось</h3>
                <p>Попробуйте другой запрос или измените фильтры.</p>
              </div>
            )}
          </div>
          <div className="pagination">
            <span>
              {filteredWords.length ? safePage * PAGE_SIZE + 1 : 0}–{Math.min((safePage + 1) * PAGE_SIZE, filteredWords.length)} из{" "}
              {filteredWords.length}
            </span>
            <div>
              <button aria-label="Предыдущая страница" disabled={safePage === 0} onClick={() => setLibraryPage(safePage - 1)}>
                <ChevronLeft size={18} />
              </button>
              <span>
                {safePage + 1} / {pageCount}
              </span>
              <button
                aria-label="Следующая страница"
                disabled={safePage + 1 >= pageCount}
                onClick={() => setLibraryPage(safePage + 1)}
              >
                <ChevronRight size={18} />
              </button>
            </div>
          </div>
        </section>
        {detail && (
          <aside className="panel word-detail" aria-label={`Подробности: ${detail.word}`}>
            <div className="detail-top">
              <span className={`tag${detail.film ? " tag-film" : ""}`}>{collectionOf(detail)}</span>
              <button className="dialog-close" aria-label="Закрыть подробности" onClick={() => setDetail(null)}>
                <X size={18} />
              </button>
            </div>
            <h2 className="detail-word">{detail.word}</h2>
            <div className="word-meta">
              <span>{detail.pos}</span>
              <button
                className={`audio-button${speechState.status !== "idle" && speechState.text === detail.word ? " is-speaking" : ""}`}
                aria-label={`Произнести ${detail.word}`}
                onClick={() => speak(detail.word)}
                title="Произнести с начала"
                aria-busy={speechState.status === "loading" && speechState.text === detail.word}
              >
                <AudioLines size={19} />
              </button>
              <a className="dictionary-link" href={dictionaryUrl(detail)} target="_blank" rel="noreferrer">
                Cambridge
                <ExternalLink size={12} />
              </a>
            </div>
            {meanings.map((word, index) => (
              <button
                key={word.id}
                className={`meaning${word.id === detail.id ? " selected" : ""}`}
                onClick={() => setDetail(word)}
                disabled={meanings.length === 1}
              >
                <span className="meaning-top">
                  <span>
                    {meanings.length > 1 && `Значение ${index + 1} · `}
                    {badgeOf(word)}
                  </span>
                  {state.cards[word.id] ? <MemoryMeter stage={stageOf(state.cards[word.id])} /> : <span>новое</span>}
                </span>
                <strong>{word.translation}</strong>
                {word.id === detail.id && word.note && <small className="term-note">{word.note}</small>}
                {word.id === detail.id && word.example && <small className="example">{renderExample(word, false)}</small>}
              </button>
            ))}
            {detailHistory.length > 0 && (
              <div className="timeline">
                <h5>ИСТОРИЯ ОТВЕТОВ{meanings.length > 1 && ` · значение ${meanings.findIndex((word) => word.id === detail.id) + 1}`}</h5>
                <div className="timeline-row">
                  {detailHistory.slice(-5).map((entry, index) => (
                    <Fragment key={entry.at}>
                      {index > 0 && <span className="timeline-line" />}
                      <span className="timeline-dot">
                        <span className={`pill pill-${entry.rating}`}>{ratingLabels[entry.rating]}</span>
                        {shortDate(entry.at)}
                      </span>
                    </Fragment>
                  ))}
                  {detailCard && (
                    <>
                      <span className="timeline-line dashed" />
                      <span className="timeline-dot">
                        <span className="pill pill-next">{detailCard.due <= now ? "сегодня" : shortDate(detailCard.due)}</span>
                        повтор
                      </span>
                    </>
                  )}
                </div>
              </div>
            )}
            <div className="today-rows detail-facts">
              <div>
                <span>Стадия</span>
                <strong>
                  {detailCard ? `${stageNames[stageOf(detailCard)]} · ${intervalLabel(detailCard.interval)}` : "Ещё не открывали"}
                </strong>
              </div>
              {detailCard && (
                <div>
                  <span>Ошибок после запоминания</span>
                  <strong>{detailCard.lapses}</strong>
                </div>
              )}
              {detailCard && (
                <div>
                  <span>Следующее повторение</span>
                  <strong>{detailCard.due <= now ? "уже пора" : dateLabel(detailCard.due)}</strong>
                </div>
              )}
            </div>
            <p className="small-note">
              {detail.film
                ? "Перевод и пример подготовлены для мода фильма. При сомнениях сверьтесь со словарём."
                : "Перевод из стороннего набора. При сомнениях сверьтесь со словарём."}
            </p>
          </aside>
        )}
      </div>
    );
  }

  function renderStats() {
    const stages = countStages(words, state);
    const masteredFrom = stages.mastered === 0 ? firstMasteryDate(words, state) : undefined;
    const filmStages = countStages(filmCards, state);
    const filmStarted = filmCards.length - filmStages.new;
    const firstAnswer = state.reviews.reduce((min, review) => Math.min(min, review.at), Infinity);
    const weekAgo = new Date(now);
    weekAgo.setHours(0, 0, 0, 0);
    weekAgo.setDate(weekAgo.getDate() - 6);
    const recent = state.reviews.filter((review) => review.at >= weekAgo.getTime() && review.at <= now);
    const peak = forecast.reduce((best, count, index) => (count > forecast[best] ? index : best), 0);
    const maxForecast = Math.max(5, ...forecast);
    // From the week of the first answer, at most the last eight weeks.
    const firstWeek = new Date(Number.isFinite(firstAnswer) ? firstAnswer : now);
    firstWeek.setHours(12, 0, 0, 0);
    firstWeek.setDate(firstWeek.getDate() - ((firstWeek.getDay() + 6) % 7));
    const calendarWeeks = Math.min(8, Math.round((weekStart.getTime() - firstWeek.getTime()) / (7 * 86_400_000)) + 1);
    const calendarStart = new Date(weekStart);
    calendarStart.setDate(calendarStart.getDate() - 7 * (calendarWeeks - 1));
    const calendar = Array.from({ length: calendarWeeks * 7 }, (_, index) => {
      const date = new Date(calendarStart);
      date.setDate(calendarStart.getDate() + index);
      const key = localDayKey(date.getTime());
      return { date, count: dayCounts.get(key) ?? 0, future: key > todayKey };
    });
    const busiest = calendar.reduce((best, cell) => (cell.count > best.count ? cell : best), calendar[0]);
    const heat = (count: number) =>
      count === 0 ? 0 : count < busiest.count / 3 ? 1 : count < (busiest.count * 2) / 3 ? 2 : 3;
    return (
      <>
        <div className="page-head">
          <h1>Прогресс</h1>
          {state.reviews.length > 0 && (
            <span>
              с {dateLabel(firstAnswer)} · {state.reviews.length.toLocaleString("ru-RU")}{" "}
              {quantity(state.reviews.length, "ответ", "ответа", "ответов")}
            </span>
          )}
        </div>
        <div className="kpi-row">
          <div className="panel">
            <span>Слов начато</span>
            <strong>
              {(oxfordStarted + filmStarted).toLocaleString("ru-RU")} <small>/ {words.length.toLocaleString("ru-RU")}</small>
            </strong>
            <em>{filmStarted ? "Oxford 3000 и фильмы" : "Oxford 3000"}</em>
          </div>
          <div className="panel">
            <span>Уверенно и закреплено</span>
            <strong>{stages.confident + stages.mastered}</strong>
            <em>интервал от 7 дней</em>
          </div>
          <div className="panel">
            <span>Вспоминаете</span>
            <strong>{recent.length ? `${successShare(recent)}%` : "—"}</strong>
            <em>«Помню» и «Легко» за 7 дней</em>
          </div>
          <div className="panel">
            <span>Серия</span>
            <strong>
              {stats.streak} <small>{quantity(stats.streak, "день", "дня", "дней")}</small>
            </strong>
            <em>{stats.streak ? "занимались каждый день" : "сегодня ещё не занимались"}</em>
          </div>
        </div>
        {activeFilm && filmProgress && (
          <section className="panel film-panel">
            <div className="panel-head">
              <h3>
                <Clapperboard size={17} />
                Мод «{activeFilm.title}»
              </h3>
              <span>
                не начато слов мода: {activeFilm.entries.filter((entry) => !state.cards[entry.id]).length}, из них новых
                слов и терминов: {filmProgress.newNotStarted}
              </span>
            </div>
            <p className="panel-description">
              Слова — доля изученных слов фильма. Речь — доля всего, что звучит в фильме: частые слова весят больше.
              Изученным считается слово, на котором последний ответ — «Помню» или «Легко».
            </p>
            <div className="film-parts">
              {[
                { title: "Обе части", film: "Весь мод", words: filmProgress.words, speech: filmProgress.speech },
                ...filmProgress.parts.map((part, index) => ({ ...part, film: activeFilm.parts[index].film })),
              ].map((part) => (
                <div className="film-part" key={part.title}>
                  <strong>{part.title}</strong>
                  <small>{part.film}</small>
                  <div className="film-metric">
                    <span>Слова</span>
                    <b>{percent(part.words)}%</b>
                  </div>
                  <div className="progress-track">
                    <div style={{ width: `${percent(part.words)}%` }} />
                  </div>
                  <small>
                    {part.words.learned} из {part.words.total}
                  </small>
                  <div className="film-metric">
                    <span>Речь</span>
                    <b>{percent(part.speech)}%</b>
                  </div>
                  <div className="progress-track">
                    <div style={{ width: `${percent(part.speech)}%` }} />
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}
        <div className="stats-grid">
          <section className="panel">
            <div className="panel-head">
              <h3>Как держатся слова</h3>
              <span>{words.length.toLocaleString("ru-RU")} слов Oxford</span>
            </div>
            <p className="panel-description">
              Стадия — по тому, через сколько дней слово придёт на повторение. Чем дольше интервал, тем прочнее память.
            </p>
            <StageBar counts={stages} total={words.length} />
            <div className="stages">
              {STAGES.map((stage) => (
                <div className="stage" key={stage}>
                  <b>
                    <i className={`stage-${stage}`} />
                    {stageNames[stage]}
                  </b>
                  <strong>{stages[stage].toLocaleString("ru-RU")}</strong>
                  <p>
                    {stageNotes[stage]}
                    {stage === "mastered" && masteredFrom && `; первые — около ${dateLabel(masteredFrom)}`}
                  </p>
                </div>
              ))}
            </div>
            <div className="level-rows">
              {levelTotals.map(({ level, words: levelWords, started }) => (
                <div className="level-row" key={level} title={levelNames[level]}>
                  <b>{level}</b>
                  <StageBar counts={countStages(levelWords, state)} total={levelWords.length} />
                  <em>
                    {started} / {levelWords.length}
                  </em>
                </div>
              ))}
              {(activeFilm || filmStarted > 0) && (
                <div className="level-row film-row" title="Новые слова и термины всех фильмов, не входящие в Oxford 3000">
                  <b>Фильмы</b>
                  <StageBar counts={filmStages} total={filmCards.length} />
                  <em>
                    {filmStarted} / {filmCards.length}
                  </em>
                </div>
              )}
            </div>
          </section>
          <div className="stats-side">
            <section className="panel">
              <div className="panel-head">
                <h3>Повторения впереди</h3>
                <span>14 дней</span>
              </div>
              <div
                className="forecast"
                role="img"
                aria-label={forecast
                  .map((count, index) => {
                    const date = new Date(now);
                    date.setDate(date.getDate() + index);
                    return `${dateLabel(date.getTime())}: ${count}`;
                  })
                  .join("; ")}
              >
                {forecast.map((count, index) => {
                  const date = new Date(now);
                  date.setDate(date.getDate() + index);
                  return (
                    <div
                      key={index}
                      className={`forecast-day${index === 0 ? " today" : ""}${index === peak && index > 0 && count > forecast[0] ? " peak" : ""}`}
                    >
                      <span>{count}</span>
                      <i style={{ height: `${Math.max(2, (count / maxForecast) * 100)}%` }} />
                      <small>{weekdays[(date.getDay() + 6) % 7]}</small>
                    </div>
                  );
                })}
              </div>
              {peak > 0 && forecast[peak] > forecast[0] && (
                <p className="note-pill">
                  <CalendarDays size={14} />
                  {dateLabel(new Date(now).setDate(new Date(now).getDate() + peak))} — {forecast[peak]}{" "}
                  {quantity(forecast[peak], "повторение", "повторения", "повторений")}: больше всего за две недели
                </p>
              )}
            </section>
            <section className="panel">
              <div className="panel-head">
                <h3>Занятия</h3>
                <span>
                  {calendarWeeks} {quantity(calendarWeeks, "неделя", "недели", "недель")}
                </span>
              </div>
              <div className="calendar" role="img" aria-label="Ответы по дням">
                {weekdays.map((name) => (
                  <span key={name}>{name}</span>
                ))}
                {calendar.map((cell) => (
                  <i
                    key={cell.date.getTime()}
                    className={cell.future ? "future" : `heat-${heat(cell.count)}`}
                    title={`${dateLabel(cell.date.getTime())}: ${cell.count} ${quantity(cell.count, "ответ", "ответа", "ответов")}`}
                  />
                ))}
              </div>
              <p className="panel-description calendar-note">
                Цвет — сколько ответов за день.
                {busiest.count > 0 &&
                  ` Больше всего — ${busiest.count} ${quantity(busiest.count, "ответ", "ответа", "ответов")}, ${dateLabel(busiest.date.getTime())}.`}
              </p>
            </section>
          </div>
        </div>
      </>
    );
  }

  function renderSettings() {
    return (
      <>
        <div className="page-head">
          <h1>Настройки</h1>
        </div>
        <div className="settings-layout">
          <section className="panel settings-panel">
            <h3>Ежедневная практика</h3>
            <div className="setting-row">
              <div>
                <label htmlFor="daily-limit">Новых слов в день</label>
                <p>Повторения уже изученных слов не ограничиваются.</p>
              </div>
              <select
                id="daily-limit"
                value={state.settings.dailyNewLimit}
                onChange={(event) =>
                  updateSettings({
                    dailyNewLimit: Number(event.target.value),
                  })
                }
              >
                {Array.from(new Set([0, 5, 10, 15, 20, 30, 50, 100, 200, state.settings.dailyNewLimit]))
                  .sort((a, b) => a - b)
                  .map((limit) => (
                    <option key={limit} value={limit}>
                      {limit === 0 ? "Только повторения" : `${limit} слов`}
                    </option>
                  ))}
              </select>
            </div>
            <div className="setting-row vertical">
              <div>
                <strong>Уровни слов</strong>
                <p>Можно выбрать несколько. Прогресс других уровней сохранится.</p>
                <p>Новые слова идут по темам внутри каждого уровня. Следующая тема начинается автоматически.</p>
              </div>
              <div className="settings-levels">
                {levels.map((level) => (
                  <button
                    key={level}
                    aria-pressed={state.settings.levels.includes(level)}
                    className={state.settings.levels.includes(level) ? "selected" : ""}
                    onClick={() => {
                      const selected = state.settings.levels.includes(level);
                      if (selected && state.settings.levels.length === 1) {
                        setToast("Оставьте хотя бы один уровень");
                        return;
                      }
                      setActiveId(null);
                      setRevealed(false);
                      updateSettings({
                        levels: selected
                          ? state.settings.levels.filter((item) => item !== level)
                          : [...state.settings.levels, level],
                      });
                    }}
                  >
                    <span>
                      {level}
                      {state.settings.levels.includes(level) && <Check size={15} />}
                    </span>
                    <small>{levelNames[level]}</small>
                  </button>
                ))}
              </div>
            </div>
            <div className="setting-row">
              <div>
                <label htmlFor="film-mode">Мод фильма</label>
                <p>
                  Новые слова фильма идут первыми, уровни на них не влияют. Без мода новые слова фильма на паузе, их
                  прогресс сохраняется.
                </p>
              </div>
              <select
                id="film-mode"
                value={state.settings.film ?? ""}
                disabled={saving}
                onChange={(event) => selectFilm(event.target.value)}
              >
                <option value="">Без мода</option>
                {films.map((film) => (
                  <option key={film.id} value={film.id}>
                    {film.title}
                  </option>
                ))}
              </select>
            </div>
            <div className="setting-row vertical">
              <div>
                <strong>Направление карточек</strong>
                <p>Расписание повторений общее для обоих направлений.</p>
              </div>
              <div className="segmented">
                <button
                  className={!reverse ? "selected" : ""}
                  onClick={() => {
                    setRevealed(false);
                    updateSettings({ direction: "en-ru" });
                  }}
                >
                  Английский → Русский
                </button>
                <button
                  className={reverse ? "selected" : ""}
                  onClick={() => {
                    setRevealed(false);
                    updateSettings({ direction: "ru-en" });
                  }}
                >
                  Русский → Английский
                </button>
              </div>
            </div>
            {isDesktop && (
              <div className="setting-row">
                <div>
                  <label htmlFor="voice">Голос</label>
                  <p>Записи нейроголосов Microsoft, встроены в приложение.</p>
                </div>
                <select
                  id="voice"
                  value={state.settings.voice}
                  disabled={saving}
                  onChange={(event) => updateSettings({ voice: event.target.value as Settings["voice"] })}
                >
                  {voices.map((voice) => (
                    <option key={voice.id} value={voice.id}>
                      {voice.name} — {voice.note}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div className="setting-row">
              <div>
                <strong>Произносить автоматически</strong>
                <p>При показе английской стороны. Зависит от голосов браузера.</p>
              </div>
              <button
                className={`toggle ${state.settings.autoSpeak ? "on" : ""}`}
                role="switch"
                aria-checked={state.settings.autoSpeak}
                aria-label="Произносить автоматически"
                onClick={() => updateSettings({ autoSpeak: !state.settings.autoSpeak })}
              >
                <span />
              </button>
            </div>
          </section>
          <div className="settings-side">
            <section className="panel">
              <h3>Внешний вид</h3>
              <div className="setting-row vertical theme-setting">
                <div>
                  <label htmlFor="theme-preference">Тема оформления</label>
                  <p>
                    {isDesktop
                      ? "Режим «Как в Windows» меняет тему автоматически."
                      : "Системный режим следует теме вашего устройства."}
                  </p>
                </div>
                <select
                  id="theme-preference"
                  value={state.settings.theme}
                  disabled={saving}
                  onChange={(event) => updateSettings({ theme: event.target.value as Settings["theme"] })}
                >
                  <option value="system">{isDesktop ? "Как в Windows" : "Как в системе"}</option>
                  <option value="light">Светлая</option>
                  <option value="dark">Тёмная</option>
                </select>
              </div>
            </section>
            <section className="panel">
              <h3>Ваш прогресс — с вами</h3>
              <p className="panel-description">
                Данные хранятся только на этом устройстве. Скачайте копию, чтобы перенести обучение или восстановить его
                после очистки браузера.
              </p>
              <button className="primary-button full" onClick={downloadBackup}>
                <ArrowDownToLine size={17} />
                Скачать копию
              </button>
              <button className="secondary-button full" onClick={() => importRef.current?.click()}>
                <ArrowUpFromLine size={17} />
                Восстановить из файла
              </button>
              {corruptStorage.current && (
                <button
                  className="text-button full"
                  onClick={() => {
                    downloadBackup();
                    setResetting(true);
                    setPendingImport(defaultState());
                  }}
                >
                  Сохранить исходные данные и начать заново
                </button>
              )}
              <input
                ref={importRef}
                type="file"
                accept=".json,application/json"
                hidden
                onChange={(event) => importBackup(event.target.files?.[0])}
              />
            </section>
            <section className="panel source-panel">
              <h3>О коллекции</h3>
              <p>
                Oxford 3000 — список базовой лексики Oxford University Press. Используется закреплённая редакция
                британского списка: 3000 карточек. Отдельные значения слова могут повторяться.
              </p>
              <p>
                Русские переводы и примеры — сторонний набор, созданный с помощью GPT‑4. Они не являются официальным
                переводом Oxford и могут содержать ошибки.
              </p>
              <a href="https://www.oxfordlearnersdictionaries.com/about/wordlists/oxford3000-5000" target="_blank" rel="noreferrer">
                Об Oxford 3000
                <ExternalLink size={13} />
              </a>
              <a href="https://github.com/ascat41/Oxford3000_en-ru" target="_blank" rel="noreferrer">
                Источник переводов
                <ExternalLink size={13} />
              </a>
              <p className="small-note">
                Независимое приложение. Не связано с Oxford University Press. Повторение: модифицированный алгоритм SM-2.
              </p>
            </section>
          </div>
        </div>
      </>
    );
  }

  function renderFilmPicker(): ReactNode {
    const search = filmQuery.trim().toLocaleLowerCase();
    const list = readiness
      .filter((item) => filmFilter === "all" || item.started || item.film.id === activeFilm?.id)
      .filter((item) => !search || `${item.film.title} ${item.film.titleEn}`.toLocaleLowerCase().includes(search))
      .sort((a, b) =>
        filmSort === "ready"
          ? b.speech - a.speech || a.film.title.localeCompare(b.film.title, "ru")
          : a.film.title.localeCompare(b.film.title, "ru"),
      );
    const startedCount = readiness.filter((item) => item.started || item.film.id === activeFilm?.id).length;
    return (
      <>
        <div className="picker-head">
          <h2>Все фильмы</h2>
          <span>
            {films.length} · одновременно включён один
          </span>
        </div>
        <div className="picker-tools">
          <label className="search-field">
            <Search size={16} />
            <input
              aria-label="Поиск фильма"
              placeholder="Название по-русски или по-английски"
              value={filmQuery}
              onChange={(event) => setFilmQuery(event.target.value)}
            />
          </label>
          <button className={`chip${filmFilter === "all" ? " on" : ""}`} onClick={() => setFilmFilter("all")}>
            Все
          </button>
          <button className={`chip${filmFilter === "started" ? " on" : ""}`} onClick={() => setFilmFilter("started")}>
            Начатые · {startedCount}
          </button>
          <select aria-label="Сортировка" value={filmSort} onChange={(event) => setFilmSort(event.target.value as "ready" | "title")}>
            <option value="ready">Ближе к просмотру</option>
            <option value="title">По названию</option>
          </select>
        </div>
        <div className="film-grid">
          {list.map((item) => {
            const selected = item.film.id === activeFilm?.id;
            return (
              <button
                key={item.film.id}
                className={`film-tile${selected ? " selected" : ""}`}
                aria-pressed={selected}
                disabled={saving}
                onClick={() => selectFilm(item.film.id)}
              >
                <span className="tile-poster">
                  <Poster film={item.film} />
                  {(selected || item.started) && <span className="tile-badge">{selected ? "Включён" : "Начат"}</span>}
                </span>
                <span className="tile-body">
                  <strong>{item.film.title}</strong>
                  <small>
                    {item.film.titleEn} · {item.film.parts.length} {quantity(item.film.parts.length, "часть", "части", "частей")}
                  </small>
                  <span className="tile-metric">
                    <span>понятно сейчас</span>
                    <b>{item.speech}%</b>
                  </span>
                  <span className="progress-track">
                    <span style={{ width: `${item.speech}%` }} />
                  </span>
                  <small>
                    {item.started || selected
                      ? `изучено ${item.words}% слов`
                      : `осталось выучить ${item.remaining} ${quantity(item.remaining, "слово", "слова", "слов")}`}
                  </small>
                </span>
              </button>
            );
          })}
          {list.length === 0 && <p className="picker-empty">Таких фильмов нет. Измените запрос или фильтр.</p>}
        </div>
        <div className="picker-foot">
          <span>
            «Понятно сейчас» — доля речи фильма, которую покрывают уже выученные слова. Частые слова весят больше.
          </span>
          <button className="secondary-button" disabled={saving || !activeFilm} onClick={() => selectFilm("")}>
            <Layers size={16} />
            Без мода
          </button>
        </div>
      </>
    );
  }

  return (
    <div className={`app-shell page-${page}${isDesktop ? " desktop-app" : ""}${focusMode && page === "study" ? " is-focus" : ""}`}>
      {isDesktop && (
        <div className="window-titlebar">
          <span className="window-titlebar-brand">
            <Layers size={16} />
            Oxford Cards
          </span>
          <span className="window-titlebar-divider" />
          <span className="window-titlebar-page">{pageNames[page]}</span>
        </div>
      )}
      <aside className="sidebar">
        <a
          className="brand"
          href="#"
          onClick={(event) => {
            event.preventDefault();
            setPage("study");
          }}
          aria-label="Oxford Cards — практика"
        >
          <span className="brand-mark">
            <Layers size={18} />
          </span>
          <span>
            <b>oxford</b>cards
          </span>
        </a>
        <nav aria-label="Основная навигация">
          {(
            [
              { id: "study", icon: Layers },
              { id: "library", icon: BookOpen },
              { id: "stats", icon: TrendingUp },
            ] as const
          ).map((item) => (
            <button
              key={item.id}
              className={`nav-item ${page === item.id ? "active" : ""}`}
              aria-current={page === item.id ? "page" : undefined}
              onClick={() => setPage(item.id)}
            >
              <item.icon size={19} />
              <span>{pageNames[item.id]}</span>
              {item.id === "study" && stats.due + stats.newAvailable > 0 && (
                <span className="nav-count">{stats.due + stats.newAvailable}</span>
              )}
            </button>
          ))}
        </nav>
        <div className="side-block">
          <div className="side-streak">
            <Flame size={17} />
            <strong>{stats.streak}</strong>
            <span>
              {quantity(stats.streak, "день", "дня", "дней")} подряд
            </span>
          </div>
          <div className="week">
            {thisWeek.map((item) => (
              <i key={item.name} className={item.today ? "today" : item.active ? "on" : ""} title={item.name}>
                {item.name[0].toUpperCase()}
              </i>
            ))}
          </div>
        </div>
        <div className="side-block">
          <div className="side-head">
            <span>Oxford 3000</span>
            <strong>{Math.floor((oxfordStarted / words.length) * 100)}%</strong>
          </div>
          <div className="progress-track">
            <div style={{ width: `${(oxfordStarted / words.length) * 100}%` }} />
          </div>
          <div className="side-levels">
            {levelTotals.map(({ level, words: levelWords, started }) => (
              <span key={level}>
                {level}
                <b>{Math.floor((started / levelWords.length) * 100)}%</b>
              </span>
            ))}
          </div>
        </div>
        <div className="sidebar-bottom">
          <button
            className={`nav-item ${page === "settings" ? "active" : ""}`}
            aria-current={page === "settings" ? "page" : undefined}
            onClick={() => setPage("settings")}
          >
            <Settings2 size={19} />
            <span>Настройки</span>
          </button>
          <div className="local-status">
            <span className={`tiny-dot ${storageError ? "error-dot" : ""}`} />
            {storageError ? "Проблема сохранения" : "Сохранено на устройстве"}
          </div>
        </div>
      </aside>
      <main className="main-content">
        {storageError && (
          <div className="error-banner" role="alert">
            {storageError}
            <button onClick={() => setPage("settings")}>Восстановить из копии</button>
          </div>
        )}
        {page === "study" && renderPractice()}
        {page === "library" && renderLibrary()}
        {page === "stats" && renderStats()}
        {page === "settings" && renderSettings()}
      </main>
      {toast && (
        <div className="toast" role="status">
          <span>{toast}</span>
          <button aria-label="Закрыть уведомление" onClick={() => setToast("")}>
            <X size={16} />
          </button>
        </div>
      )}
      <dialog
        ref={dialogRef}
        className={`app-dialog${filmPicker && !pendingImport ? " picker-dialog" : ""}`}
        onCancel={() => {
          setPendingImport(null);
          setFilmPicker(false);
        }}
        onClick={(event) => {
          if (event.target === event.currentTarget) {
            setPendingImport(null);
            setFilmPicker(false);
          }
        }}
      >
        <button
          className="dialog-close"
          aria-label="Закрыть"
          onClick={() => {
            setPendingImport(null);
            setFilmPicker(false);
          }}
        >
          <X size={20} />
        </button>
        {filmPicker && !pendingImport && renderFilmPicker()}
        {pendingImport && (
          <>
            <span className="dialog-icon">
              <ArrowUpFromLine size={22} />
            </span>
            <h2 className="import-title">{resetting ? "Начать заново?" : "Восстановить прогресс?"}</h2>
            <p>
              В копии: {Object.keys(pendingImport.cards).length} изученных карточек и {pendingImport.reviews.length}{" "}
              ответов. Текущий прогресс и настройки будут заменены.
            </p>
            <div className="dialog-actions">
              <button className="secondary-button" onClick={() => setPendingImport(null)}>
                Отмена
              </button>
              <button className="primary-button" disabled={saving} onClick={confirmImport}>
                {resetting ? "Начать заново" : "Восстановить"}
              </button>
            </div>
          </>
        )}
      </dialog>
    </div>
  );
}
