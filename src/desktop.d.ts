interface Window {
  oxfordAudio?: {
    prepare(text: string): Promise<{ audioBase64: string; voice: string; lang: string }>;
  };
  oxfordTheme?: {
    setSource(source: "system" | "light" | "dark"): Promise<void>;
  };
}
