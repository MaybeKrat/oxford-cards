// Bundled film modes with their pictures and term labels; a new film is added here and in scripts/build-films.py.
import duneFilm from "./data/films/dune.json";
import zootopiaFilm from "./data/films/zootopia.json";
import dunePoster from "./assets/films/dune.webp";
import zootopiaPoster from "./assets/films/zootopia.webp";
import { loadFilm } from "./lib/films";
import type { Film } from "./lib/types";

type RawFilm = Parameters<typeof loadFilm>[0];

export const films: Film[] = [loadFilm(duneFilm as RawFilm), loadFilm(zootopiaFilm as RawFilm)];
export const filmPosters: Record<string, string> = { dune: dunePoster, zootopia: zootopiaPoster };
export const filmTermLabels: Record<string, string> = { dune: "Термин Дюны", zootopia: "Термин Зверополиса" };
