// Titles for "New Terminal" tasks, which have no prompt to derive one from.
export const TERMINAL_TITLES = [
  'Andromeda', 'Antlia', 'Apus', 'Aquarius', 'Aquila', 'Ara', 'Aries', 'Auriga',
  'Bootes', 'Caelum', 'Camelopardalis', 'Cancer', 'Canis Major', 'Canis Minor',
  'Capricornus', 'Carina', 'Cassiopeia', 'Centaurus', 'Cepheus', 'Cetus',
  'Chamaeleon', 'Circinus', 'Columba', 'Corona Borealis', 'Corvus', 'Crater',
  'Crux', 'Cygnus', 'Delphinus', 'Dorado', 'Draco', 'Eridanus', 'Fornax',
  'Gemini', 'Grus', 'Hercules', 'Horologium', 'Hydra', 'Lacerta', 'Leo',
  'Lepus', 'Libra', 'Lupus', 'Lynx', 'Lyra', 'Monoceros', 'Norma', 'Octans',
  'Ophiuchus', 'Orion', 'Pavo', 'Pegasus', 'Perseus', 'Phoenix', 'Pictor',
  'Pisces', 'Puppis', 'Pyxis', 'Reticulum', 'Sagitta', 'Sagittarius',
  'Scorpius', 'Sculptor', 'Scutum', 'Serpens', 'Taurus', 'Telescopium',
  'Triangulum', 'Tucana', 'Ursa Major', 'Ursa Minor', 'Vela', 'Virgo',
  'Volans', 'Vulpecula',
];

export function randomTerminalTitle(random: () => number = Math.random): string {
  return TERMINAL_TITLES[Math.floor(random() * TERMINAL_TITLES.length)];
}
