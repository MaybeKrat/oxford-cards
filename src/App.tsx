import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  ArrowUpFromLine,
  AudioLines,
  BookOpen,
  Check,
  CheckCheck,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Clock3,
  ExternalLink,
  Flame,
  Layers,
  Leaf,
  RotateCcw,
  Search,
  Settings2,
  Sparkles,
  Sprout,
  TrendingUp,
  X,
} from "lucide-react";
import vocabulary from "./data/oxford3000.json";
import {
  addExtraNewWords,
  defaultState,
  getDailyNewLimit,
  getStats,
  getStudyQueue,
  scheduleCard,
} from "./lib/scheduler";
import { parseBackup, readState, writeState, STORAGE_KEY } from "./lib/storage";
import { createSpeechController } from "./lib/speech";
import { createBufferedSpeechController } from "./lib/buffered-speech";
import { applyTheme, SYSTEM_THEME_QUERY } from "./lib/theme";
import type { SpeechController, SpeechStatus } from "./lib/speech";
import type { AppState, Level, Rating, Settings, Word } from "./lib/types";

const words = vocabulary as Word[];
const isDesktop = window.location.protocol === "oxford:";
const validIds = new Set(words.map((word) => word.id));
const levels: Level[] = ["A1", "A2", "B1", "B2"];
const studyWords = [...words].sort(
  (a, b) => levels.indexOf(a.level) - levels.indexOf(b.level),
);
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
type Page = "study" | "library" | "stats" | "settings";
const pageNames = {
  study: "Практика",
  library: "Мой словарь",
  stats: "Прогресс",
  settings: "Настройки",
};
function dayKey(time: number) {
  const d = new Date(time);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}
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
function dictionaryUrl(word: Word) {
  return `https://dictionary.cambridge.org/dictionary/english-russian/${encodeURIComponent(
    word.word
      .split(",")[0]
      .replace(/\s*\([^)]*\)/g, "")
      .trim(),
  )}`;
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

export default function App() {
  const [initial] = useState(initialState);
  const [state, setState] = useState(initial.state);
  const [storageError, setStorageError] = useState(initial.error);
  const [page, setPage] = useState<Page>("study");
  const [now, setNow] = useState(Date.now());
  const [revealed, setRevealed] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [undoState, setUndoState] = useState<AppState | null>(null);
  const [toast, setToast] = useState("");
  const [speechState, setSpeechState] = useState<{ status: SpeechStatus; text: string }>({ status: "idle", text: "" });
  const [query, setQuery] = useState("");
  const [libraryLevel, setLibraryLevel] = useState("all");
  const [libraryStatus, setLibraryStatus] = useState("all");
  const [libraryPage, setLibraryPage] = useState(0);
  const [detail, setDetail] = useState<Word | null>(null);
  const [pendingImport, setPendingImport] = useState<AppState | null>(null);
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const storedRaw = useRef(initial.raw);
  const corruptStorage = useRef(!!initial.error);
  const savingRef = useRef(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const speech = useRef<(SpeechController & { prepare?: (text: string) => void }) | null>(null);
  const queue = useMemo(
    () => getStudyQueue(studyWords, state, now),
    [state, now],
  );
  const current = queue.find((word) => word.id === activeId) ?? queue[0];
  const stats = useMemo(() => getStats(words, state, now), [state, now]);
  const reverse = state.settings.direction === "ru-en";
  const today = dayKey(now);
  const todayNew = new Set(
    state.reviews
      .filter((review) => review.isNew && review.at <= now && dayKey(review.at) === today)
      .map((review) => review.wordId),
  ).size;
  const dailyNewLimit = getDailyNewLimit(state, now);
  const extraWordsCount = Math.min(
    10,
    words.filter((word) => state.settings.levels.includes(word.level) && !state.cards[word.id]).length,
  );
  const dailyProgress =
    dailyNewLimit === 0
      ? 0
      : Math.min(
          100,
          Math.round((todayNew / dailyNewLimit) * 100),
        );

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
  }, []);
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
    const nextId = current?.id ?? null;
    if (activeId !== nextId) {
      setRevealed(false);
      setActiveId(nextId);
    }
  }, [current?.id, activeId]);
  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(""), 6000);
    return () => clearTimeout(id);
  }, [toast]);
  useEffect(() => {
    if (detail || pendingImport) dialogRef.current?.showModal();
    else dialogRef.current?.close();
  }, [detail, pendingImport]);
  useEffect(() => {
    setLibraryPage(0);
  }, [query, libraryLevel, libraryStatus]);
  useEffect(() => {
    speech.current?.stop();
  }, [current?.id, page, reverse, detail?.id, !!pendingImport, state.settings.autoSpeak]);
  useEffect(() => {
    // Preparation is silent, including on the hidden side of reverse cards.
    const text = detail?.word ?? (page === "study" ? current?.word : undefined);
    if (text && !pendingImport) speech.current?.prepare?.(text);
  }, [current?.id, page, detail?.id, !!pendingImport]);
  useEffect(() => {
    if (
      page === "study" &&
      current &&
      current.id === activeId &&
      !detail &&
      !pendingImport &&
      !document.hidden &&
      state.settings.autoSpeak &&
      (!reverse || revealed)
    )
      speak(current.word);
  }, [
    current?.id,
    activeId,
    page,
    detail?.id,
    !!pendingImport,
    state.settings.autoSpeak,
    reverse,
    reverse && revealed,
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
  async function rate(rating: Rating) {
    if (!current || !revealed) return;
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
    if (getStudyQueue(studyWords, state, at).length > 0) {
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
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (
        page !== "study" ||
        detail ||
        pendingImport ||
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
      if (
        event.code === "Space" &&
        current &&
        !revealed &&
        !(event.target as HTMLElement).closest("button,a")
      ) {
        event.preventDefault();
        setRevealed(true);
      }
      if (revealed && ["1", "2", "3", "4"].includes(event.key)) {
        event.preventDefault();
        rate(ratings[Number(event.key) - 1]);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const filteredWords = useMemo(
    () =>
      words.filter((word) => {
        const progress = state.cards[word.id];
        const matchesStatus =
          libraryStatus === "all" ||
          (libraryStatus === "new" && !progress) ||
          (libraryStatus === "due" && progress && progress.due <= now) ||
          (libraryStatus === "started" && !!progress);
        return (
          matchesStatus &&
          (libraryLevel === "all" || word.level === libraryLevel) &&
          `${word.word} ${word.translation}`
            .toLocaleLowerCase()
            .includes(query.trim().toLocaleLowerCase())
        );
      }),
    [query, libraryLevel, libraryStatus, state.cards, now],
  );
  const pageCount = Math.max(1, Math.ceil(filteredWords.length / 30));
  const safePage = Math.min(libraryPage, pageCount - 1);
  const week = Array.from({ length: 7 }, (_, index) => {
    const date = new Date(now);
    date.setDate(date.getDate() - 6 + index);
    const key = dayKey(date.getTime());
    return {
      date,
      count: state.reviews.filter((review) => dayKey(review.at) === key).length,
    };
  });
  const maxCount = Math.max(5, ...week.map((day) => day.count));
  const nextDue = words
    .filter((word) => state.settings.levels.includes(word.level))
    .map((word) => state.cards[word.id])
    .filter((card) => card?.due > now)
    .sort((a, b) => a.due - b.due)[0]?.due;
  const successful = state.reviews.filter(
    (review) => review.rating === "good" || review.rating === "easy",
  ).length;
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
  const statusOf = (word: Word) =>
    !state.cards[word.id]
      ? "Новое"
      : state.cards[word.id].due <= now
        ? "Пора повторить"
        : state.cards[word.id].interval >= 21 &&
            state.cards[word.id].state === "review"
          ? "Закреплено"
          : "В изучении";

  return (
    <div className={`app-shell page-${page}${isDesktop ? " desktop-app" : ""}`}>
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
            <Layers size={23} />
          </span>
          <span>
            oxford<span className="brand-light">cards</span>
            <small>СЛОВА ОСТАЮТСЯ С ВАМИ</small>
          </span>
        </a>
        <div className="sidebar-caption">ВАШЕ ПРОСТРАНСТВО</div>
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
              <item.icon size={20} />
              <span>{pageNames[item.id]}</span>
              {item.id === "study" && stats.due > 0 && (
                <span className="nav-count">{stats.due}</span>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-collection">
          <span className="collection-symbol">
            <BookOpen size={19} />
          </span>
          <div>
            <strong>Oxford 3000</strong>
            <span>Ваша коллекция слов</span>
          </div>
          <span className="tiny-dot" />
        </div>
        <div className="sidebar-bottom">
          <div className="daily-note">
            <Sprout size={27} />
            <strong>Понемногу. Каждый день.</strong>
            <p>Пять минут сегодня — ещё один шаг к свободному английскому.</p>
          </div>
          <button
            className={`nav-item ${page === "settings" ? "active" : ""}`}
            onClick={() => setPage("settings")}
          >
            <Settings2 size={19} />
            Настройки
          </button>
          <div className="local-status">
            <span className={`tiny-dot ${storageError ? "error-dot" : ""}`} />
            {storageError
              ? "Проблема сохранения"
              : "Прогресс сохранён на устройстве"}
          </div>
        </div>
      </aside>
      <main className="main-content">
        <header className="topbar">
          <span>
            <span className="breadcrumb">Моё обучение</span>
            <ChevronRight size={14} />
            {pageNames[page]}
          </span>
          <span className="topbar-date">
            {new Date(now).toLocaleDateString("ru-RU", {
              day: "numeric",
              month: "long",
              weekday: "short",
            })}
            <span className="avatar">Я</span>
          </span>
        </header>
        {storageError && (
          <div className="error-banner" role="alert">
            {storageError}
            <button onClick={() => setPage("settings")}>
              Восстановить из копии
            </button>
          </div>
        )}
        {page === "study" && (
          <>
            <section className="summary-grid" aria-label="Сегодня">
              <div className="summary-card">
                <span className="stat-icon sage">
                  <Layers size={21} />
                </span>
                <div>
                  <span>К повторению</span>
                  <strong>
                    {stats.due}
                    <small> карточек</small>
                  </strong>
                </div>
                <span className="stat-tag">Сегодня</span>
              </div>
              <div className="summary-card">
                <span className="stat-icon lavender">
                  <Sparkles size={21} />
                </span>
                <div>
                  <span>Новые слова</span>
                  <strong>
                    {stats.newAvailable}
                    <small> на сегодня</small>
                  </strong>
                </div>
              </div>
              <div className="summary-card">
                <span className="stat-icon peach">
                  <Flame size={22} />
                </span>
                <div>
                  <span>Ваша серия</span>
                  <strong>
                    {stats.streak}
                    <small>
                      {" "}
                      {quantity(stats.streak, "день", "дня", "дней")} подряд
                    </small>
                  </strong>
                </div>
              </div>
            </section>
            <div className="study-layout">
              <section className="practice-section">
                <div className="section-title">
                  <h2>Время для практики</h2>
                  <span className="subtle">
                    {current ? `${queue.length} в очереди` : "Всё на сегодня"}
                  </span>
                </div>
                {current ? (
                  <>
                    <div
                      className={`flashcard ${revealed ? "is-revealed" : ""}`}
                      key={current.id}
                    >
                      <div className="card-top">
                        <span className="card-collection">
                          <span className="tiny-dot" />
                          OXFORD 3000
                        </span>
                        <span className="level-badge">{current.level}</span>
                      </div>
                      <div className="card-word-area">
                        <span className="word-label">
                          {reverse
                            ? "КАК ЭТО ПО-АНГЛИЙСКИ?"
                            : "ВСПОМНИТЕ ПЕРЕВОД"}
                        </span>
                        <h2
                          className={`card-word ${reverse ? "translation-prompt" : ""}`}
                        >
                          {reverse ? current.translation : current.word}
                        </h2>
                        {!reverse && current.phonetic && (
                          <span className="phonetic">{current.phonetic}</span>
                        )}
                        <span className="part-of-speech">{current.pos}</span>
                        {(!reverse || revealed) && (
                          <button
                            className={`audio-button${speechState.status !== "idle" && speechState.text === current.word ? " is-speaking" : ""}`}
                            onClick={() => speak(current.word)}
                            aria-label={`Произнести ${current.word}`}
                            title="Произнести с начала"
                            aria-busy={speechState.status === "loading" && speechState.text === current.word}
                          >
                            <AudioLines size={20} />
                          </button>
                        )}
                        {revealed && (
                          <div className="answer" aria-live="polite">
                            <span className="answer-divider" />
                            <h3>
                              {reverse ? current.word : current.translation}
                            </h3>
                            {current.example && (
                              <p className="example">{current.example}</p>
                            )}
                            {current.exampleTranslation && (
                              <p className="example-translation">
                                {current.exampleTranslation}
                              </p>
                            )}
                            <a
                              href={dictionaryUrl(current)}
                              target="_blank"
                              rel="noreferrer"
                            >
                              Проверить в словаре
                              <ExternalLink size={12} />
                            </a>
                          </div>
                        )}
                      </div>
                      <div className="card-bottom">
                        <span>
                          {state.cards[current.id]
                            ? "Повторение"
                            : "Новое слово"}
                          <span className="middle-dot">·</span>
                          {reverse
                            ? "Русский → Английский"
                            : "Английский → Русский"}
                        </span>
                        <span>
                          {revealed
                            ? "Насколько легко вспомнили?"
                            : "Не спешите. Попробуйте вспомнить."}
                        </span>
                      </div>
                    </div>
                    {!revealed ? (
                      <button
                        className="reveal-button"
                        onClick={() => setRevealed(true)}
                      >
                        Показать перевод
                        <ArrowRight size={18} />
                        <kbd>Пробел</kbd>
                      </button>
                    ) : (
                      <div className="rating-grid" aria-label="Оцените ответ">
                        {ratings.map((rating, index) => (
                          <button
                            key={rating}
                            className={`rating rating-${rating}`}
                            disabled={saving}
                            onClick={() => rate(rating)}
                          >
                            <span>
                              {ratingLabels[rating]}
                              <kbd>{index + 1}</kbd>
                            </span>
                            <small>
                              {intervalLabel(
                                scheduleCard(
                                  state.cards[current.id],
                                  rating,
                                  now,
                                ).interval,
                              )}
                            </small>
                          </button>
                        ))}
                      </div>
                    )}
                    <div className="practice-footer">
                      <span>
                        <CircleHelp size={14} />
                        {revealed
                          ? "Оцените ответ клавишами 1–4"
                          : "Сначала вспомните сами, затем откройте ответ"}
                      </span>
                      <button disabled={!undoState || saving} onClick={undo}>
                        <RotateCcw size={14} />
                        Отменить
                      </button>
                    </div>
                  </>
                ) : (
                  <div className="empty-practice">
                    <span className="complete-icon">
                      <CheckCheck size={35} />
                    </span>
                    <h2>
                      {stats.started === 0
                        ? "Выберите слова для старта"
                        : "Отличная работа!"}
                    </h2>
                    <p>
                      Сейчас в выбранных уровнях нет карточек к повторению.
                      {extraWordsCount === 0
                        ? " Вы уже познакомились со всеми словами выбранных уровней."
                        : dailyNewLimit === 0
                        ? " Новые слова отключены в настройках."
                        : todayNew >= dailyNewLimit
                          ? " План по новым словам на сегодня выполнен."
                          : ""}
                    </p>
                    {nextDue && (
                      <span className="next-review">
                        <Clock3 size={16} />
                        Ближайшее повторение:{" "}
                        {new Date(nextDue).toLocaleString("ru-RU", {
                          day: "numeric",
                          month: "short",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </span>
                    )}
                    {extraWordsCount > 0 && (
                      <>
                        <button
                          className="primary-button"
                          disabled={saving || !!storageError}
                          onClick={studyMoreToday}
                        >
                          Изучить сегодня ещё {extraWordsCount}{" "}
                          {quantity(extraWordsCount, "слово", "слова", "слов")}
                          <ArrowRight size={16} />
                        </button>
                        <p className="extra-today-note">
                          Только на сегодня. Обычный дневной лимит не изменится.
                        </p>
                      </>
                    )}
                    <button
                      className={extraWordsCount > 0 ? "secondary-button" : "primary-button"}
                      onClick={() => setPage("library")}
                    >
                      Посмотреть словарь
                      <ArrowRight size={16} />
                    </button>
                    {undoState && (
                      <button className="text-button" disabled={saving} onClick={undo}>
                        <RotateCcw size={15} />
                        Отменить последнюю оценку
                      </button>
                    )}
                  </div>
                )}
              </section>
              <aside className="study-aside">
                <section className="daily-card">
                  <div className="section-title">
                    <h3>Маленькая цель на день</h3>
                    <Leaf size={19} />
                  </div>
                  <div className="goal-value">
                    {dailyNewLimit === 0 ? (
                      "Пауза"
                    ) : (
                      <>
                        {todayNew}
                        <span>/ {dailyNewLimit}</span>
                      </>
                    )}
                  </div>
                  <p>
                    {dailyNewLimit === 0
                      ? "новые слова отключены"
                      : "новых слов изучено"}
                  </p>
                  <div className="progress-track">
                    <div style={{ width: `${dailyProgress}%` }} />
                  </div>
                  <div className="goal-caption">
                    <span>
                      {dailyNewLimit === 0
                        ? "Сегодня — только повторения"
                        : dailyProgress >= 100
                          ? "Цель достигнута!"
                          : "Каждое слово — шаг вперёд"}
                    </span>
                    {dailyProgress >= 100 ? (
                      <Check size={15} />
                    ) : (
                      <span>{dailyProgress}%</span>
                    )}
                  </div>
                </section>
                <section className="method-card">
                  <span className="mini-label">
                    УЧИТЬ МЕНЬШЕ. ПОМНИТЬ ДОЛЬШЕ.
                  </span>
                  <h3>В нужный момент.</h3>
                  <p>
                    Сложные слова вернутся раньше, знакомые — позже. Просто
                    оцените, насколько легко вспомнили ответ.
                  </p>
                  <div className="interval-illustration" aria-hidden="true">
                    <span>1д</span>
                    <i />
                    <span>6д</span>
                    <i />
                    <span>15д</span>
                    <i />
                    <span>…</span>
                  </div>
                  <span className="method-caption">
                    Интервальное повторение
                  </span>
                </section>
                <button
                  className="collection-link"
                  onClick={() => setPage("library")}
                >
                  <BookOpen size={20} />
                  <span>
                    <strong>Ваша коллекция</strong>
                    <small>
                      {words.length.toLocaleString("ru-RU")} карточек · A1–B2
                    </small>
                  </span>
                  <ArrowRight size={17} />
                </button>
              </aside>
            </div>
          </>
        )}
        {page === "library" && (
          <>
            <section className="page-heading compact">
              <div>
                <div className="eyebrow">
                  <span />
                  OXFORD 3000
                </div>
                <h1>Слово за словом.</h1>
                <p>
                  Весь словарь в одном месте. Найдите слово и познакомьтесь
                  ближе.
                </p>
              </div>
              <span className="large-count">
                {words.length.toLocaleString("ru-RU")}
                <small>карточек для роста</small>
              </span>
            </section>
            <div className="library-controls">
              <label className="search-field">
                <Search size={19} />
                <input
                  aria-label="Поиск слова или перевода"
                  placeholder="Найти слово или перевод…"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
                {query && (
                  <button
                    aria-label="Очистить поиск"
                    onClick={() => setQuery("")}
                  >
                    <X size={16} />
                  </button>
                )}
              </label>
              <select
                aria-label="Фильтр по статусу"
                value={libraryStatus}
                onChange={(event) => setLibraryStatus(event.target.value)}
              >
                <option value="all">Все слова</option>
                <option value="new">Новые</option>
                <option value="started">В изучении</option>
                <option value="due">Пора повторить</option>
              </select>
            </div>
            <div className="filter-row">
              <div className="level-filters">
                {["all", ...levels].map((level) => (
                  <button
                    key={level}
                    className={libraryLevel === level ? "selected" : ""}
                    onClick={() => setLibraryLevel(level)}
                  >
                    {level === "all" ? "Все уровни" : level}
                  </button>
                ))}
              </div>
              <span className="subtle">Найдено: {filteredWords.length}</span>
            </div>
            <div className="word-table">
              <div className="table-head">
                <span>АНГЛИЙСКИЙ</span>
                <span>ПЕРЕВОД</span>
                <span>УРОВЕНЬ</span>
                <span>ПРОГРЕСС</span>
              </div>
              {filteredWords
                .slice(safePage * 30, safePage * 30 + 30)
                .map((word) => (
                  <button
                    className="word-row"
                    key={word.id}
                    onClick={() => setDetail(word)}
                  >
                    <span>
                      <strong>{word.word}</strong>
                      <small>{word.pos}</small>
                    </span>
                    <span className="row-translation">{word.translation}</span>
                    <span>
                      <span className="level-badge">{word.level}</span>
                    </span>
                    <span
                      className={`word-status ${state.cards[word.id] ? "started" : ""}`}
                    >
                      <span />
                      {statusOf(word)}
                    </span>
                  </button>
                ))}
              {filteredWords.length === 0 && (
                <div className="no-results">
                  <Search size={30} />
                  <h3>Такого слова не нашлось</h3>
                  <p>Попробуйте другой запрос или измените фильтры.</p>
                </div>
              )}
            </div>
            <div className="pagination">
              <span>
                {filteredWords.length ? safePage * 30 + 1 : 0}–
                {Math.min((safePage + 1) * 30, filteredWords.length)} из{" "}
                {filteredWords.length}
              </span>
              <div>
                <button
                  aria-label="Предыдущая страница"
                  disabled={safePage === 0}
                  onClick={() => setLibraryPage(safePage - 1)}
                >
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
          </>
        )}
        {page === "stats" && (
          <>
            <section className="page-heading compact">
              <div>
                <div className="eyebrow">
                  <span />
                  КАЖДЫЙ ШАГ ИМЕЕТ ЗНАЧЕНИЕ
                </div>
                <h1>Растёт ваш английский.</h1>
                <p>
                  Здесь видны маленькие усилия, которые складываются в
                  результат.
                </p>
              </div>
              <Sprout className="page-symbol" size={64} />
            </section>
            <section className="summary-grid">
              <div className="summary-card">
                <span className="stat-icon sage">
                  <BookOpen size={21} />
                </span>
                <div>
                  <span>Слов в изучении</span>
                  <strong>
                    {stats.started}
                    <small> / {words.length}</small>
                  </strong>
                </div>
              </div>
              <div className="summary-card">
                <span className="stat-icon lavender">
                  <CheckCheck size={21} />
                </span>
                <div>
                  <span>Закреплено</span>
                  <strong>
                    {stats.learned}
                    <small> слов</small>
                  </strong>
                </div>
              </div>
              <div className="summary-card">
                <span className="stat-icon peach">
                  <Flame size={21} />
                </span>
                <div>
                  <span>Серия занятий</span>
                  <strong>
                    {stats.streak}
                    <small>
                      {" "}
                      {quantity(stats.streak, "день", "дня", "дней")}
                    </small>
                  </strong>
                </div>
              </div>
            </section>
            <div className="stats-layout">
              <section className="panel weekly-panel">
                <div className="section-title">
                  <h2>Ваш ритм</h2>
                  <span className="subtle">Последние 7 дней</span>
                </div>
                <p className="panel-description">
                  Каждый столбик — ваши ответы за день.
                </p>
                <div
                  className="week-chart"
                  role="img"
                  aria-label={week
                    .map(
                      (day) =>
                        `${dateLabel(day.date.getTime())}: ${day.count} ответов`,
                    )
                    .join("; ")}
                >
                  {week.map((day, i) => (
                    <div className="chart-column" key={i}>
                      <span className="bar-count">{day.count}</span>
                      <div className="bar-track">
                        <div
                          className={i === 6 ? "today-bar" : ""}
                          style={{
                            height: `${Math.max(2, (day.count / maxCount) * 100)}%`,
                          }}
                        />
                      </div>
                      <span className={i === 6 ? "today-label" : ""}>
                        {day.date.toLocaleDateString("ru-RU", {
                          weekday: "short",
                        })}
                      </span>
                    </div>
                  ))}
                </div>
                <div className="chart-footer">
                  <span>
                    Всего ответов <strong>{state.reviews.length}</strong>
                  </span>
                  <span>
                    «Помню» и «Легко»{" "}
                    <strong>
                      {state.reviews.length
                        ? Math.round((successful / state.reviews.length) * 100)
                        : 0}
                      %
                    </strong>
                  </span>
                </div>
              </section>
              <section className="panel levels-panel">
                <h2>От базы к свободе</h2>
                <p className="panel-description">
                  Прогресс знакомства со словами
                </p>
                {levels.map((level) => {
                  const total = words.filter(
                    (word) => word.level === level,
                  ).length;
                  const started = words.filter(
                    (word) => word.level === level && state.cards[word.id],
                  ).length;
                  return (
                    <div className="level-progress" key={level}>
                      <div>
                        <span className="level-badge">{level}</span>
                        <strong>{levelNames[level]}</strong>
                        <small>
                          {started} / {total}
                        </small>
                      </div>
                      <div className="progress-track">
                        <div style={{ width: `${(started / total) * 100}%` }} />
                      </div>
                    </div>
                  );
                })}
                <p className="small-note">
                  Закреплёнными считаем слова с интервалом повторения от 21 дня.
                </p>
              </section>
            </div>
          </>
        )}
        {page === "settings" && (
          <>
            <section className="page-heading compact">
              <div>
                <div className="eyebrow">
                  <span />В ВАШЕМ ТЕМПЕ
                </div>
                <h1>Привычка под вас.</h1>
                <p>Выберите комфортную нагрузку и сохраните свой прогресс.</p>
              </div>
            </section>
            <div className="settings-layout">
              <section className="panel settings-panel">
                <h2>Ежедневная практика</h2>
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
                    {Array.from(
                      new Set([
                        0,
                        5,
                        10,
                        15,
                        20,
                        30,
                        50,
                        100,
                        200,
                        state.settings.dailyNewLimit,
                      ]),
                    )
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
                    <p>
                      Можно выбрать несколько. Прогресс других уровней
                      сохранится.
                    </p>
                  </div>
                  <div className="settings-levels">
                    {levels.map((level) => (
                      <button
                        key={level}
                        aria-pressed={state.settings.levels.includes(level)}
                        className={
                          state.settings.levels.includes(level)
                            ? "selected"
                            : ""
                        }
                        onClick={() => {
                          const selected =
                            state.settings.levels.includes(level);
                          if (selected && state.settings.levels.length === 1) {
                            setToast("Оставьте хотя бы один уровень");
                            return;
                          }
                          setActiveId(null);
                          setRevealed(false);
                          updateSettings({
                            levels: selected
                              ? state.settings.levels.filter(
                                  (item) => item !== level,
                                )
                              : [...state.settings.levels, level],
                          });
                        }}
                      >
                        <span>
                          {level}
                          {state.settings.levels.includes(level) && (
                            <Check size={15} />
                          )}
                        </span>
                        <small>{levelNames[level]}</small>
                      </button>
                    ))}
                  </div>
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
                <div className="setting-row">
                  <div>
                    <strong>Произносить автоматически</strong>
                    <p>
                      При показе английской стороны. Зависит от голосов
                      браузера.
                    </p>
                  </div>
                  <button
                    className={`toggle ${state.settings.autoSpeak ? "on" : ""}`}
                    role="switch"
                    aria-checked={state.settings.autoSpeak}
                    aria-label="Произносить автоматически"
                    onClick={() =>
                      updateSettings({ autoSpeak: !state.settings.autoSpeak })
                    }
                  >
                    <span />
                  </button>
                </div>
              </section>
              <div className="settings-side">
                <section className="panel appearance-panel">
                  <h2>Внешний вид</h2>
                  <div className="setting-row theme-setting">
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
                  <span className="stat-icon sage">
                    <ArrowDownToLine size={21} />
                  </span>
                  <h2>Ваш прогресс — с вами</h2>
                  <p className="panel-description">
                    Данные хранятся только на этом устройстве. Скачайте копию,
                    чтобы перенести обучение или восстановить его после очистки
                    браузера.
                  </p>
                  <button
                    className="primary-button full"
                    onClick={downloadBackup}
                  >
                    <ArrowDownToLine size={17} />
                    Скачать копию
                  </button>
                  <button
                    className="secondary-button full"
                    onClick={() => importRef.current?.click()}
                  >
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
                    Oxford 3000 — список базовой лексики Oxford University
                    Press. Используется закреплённая редакция британского
                    списка: 3000 карточек. Отдельные значения слова могут
                    повторяться.
                  </p>
                  <p>
                    Русские переводы и примеры — сторонний набор, созданный с
                    помощью GPT‑4. Они не являются официальным переводом Oxford
                    и могут содержать ошибки.
                  </p>
                  <a
                    href="https://www.oxfordlearnersdictionaries.com/about/wordlists/oxford3000-5000"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Об Oxford 3000
                    <ExternalLink size={13} />
                  </a>
                  <a
                    href="https://github.com/ascat41/Oxford3000_en-ru"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Источник переводов
                    <ExternalLink size={13} />
                  </a>
                  <p className="small-note">
                    Независимое приложение. Не связано с Oxford University
                    Press. Повторение: модифицированный алгоритм SM-2.
                  </p>
                </section>
              </div>
            </div>
          </>
        )}
        <footer className="page-footer">
          <span>
            <Leaf size={14} />
            Пусть новые слова становятся своими.
          </span>
          <span>
            Oxford Cards<span className="middle-dot">·</span>Личная практика
          </span>
        </footer>
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
        className="detail-dialog"
        onCancel={() => {
          setDetail(null);
          setPendingImport(null);
        }}
        onClick={(event) => {
          if (event.target === event.currentTarget) {
            setDetail(null);
            setPendingImport(null);
          }
        }}
      >
        <button
          className="dialog-close"
          aria-label="Закрыть"
          onClick={() => {
            setDetail(null);
            setPendingImport(null);
          }}
        >
          <X size={20} />
        </button>
        {detail && (
          <>
            <span className="level-badge">{detail.level}</span>
            <h2>{detail.word}</h2>
            <span className="part-of-speech">{detail.pos}</span>
            <button
              className={`audio-button${speechState.status !== "idle" && speechState.text === detail.word ? " is-speaking" : ""}`}
              aria-label={`Произнести ${detail.word}`}
              onClick={() => speak(detail.word)}
              title="Произнести с начала"
              aria-busy={speechState.status === "loading" && speechState.text === detail.word}
            >
              <AudioLines size={20} />
            </button>
            <h3>{detail.translation}</h3>
            {detail.example && <p className="example">{detail.example}</p>}
            {detail.exampleTranslation && (
              <p className="example-translation">{detail.exampleTranslation}</p>
            )}
            <div className="detail-progress">
              <span>{statusOf(detail)}</span>
              {state.cards[detail.id] && (
                <span>Повторить: {dateLabel(state.cards[detail.id].due)}</span>
              )}
            </div>
            <a
              className="dictionary-link"
              href={dictionaryUrl(detail)}
              target="_blank"
              rel="noreferrer"
            >
              Открыть в Cambridge Dictionary
              <ExternalLink size={14} />
            </a>
            <p className="small-note">
              Перевод из стороннего набора. При сомнениях сверьтесь со словарём.
            </p>
          </>
        )}
        {pendingImport && (
          <>
            <span className="stat-icon sage">
              <ArrowUpFromLine size={24} />
            </span>
            <h2 className="import-title">
              {resetting ? "Начать заново?" : "Восстановить прогресс?"}
            </h2>
            <p>
              В копии: {Object.keys(pendingImport.cards).length} изученных
              карточек и {pendingImport.reviews.length} ответов. Текущий
              прогресс и настройки будут заменены.
            </p>
            <div className="dialog-actions">
              <button
                className="secondary-button"
                onClick={() => setPendingImport(null)}
              >
                Отмена
              </button>
              <button
                className="primary-button"
                disabled={saving}
                onClick={confirmImport}
              >
                {resetting ? "Начать заново" : "Восстановить"}
              </button>
            </div>
          </>
        )}
      </dialog>
    </div>
  );
}
