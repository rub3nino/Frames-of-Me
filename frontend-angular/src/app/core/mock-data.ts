/**
 * Dati mock locali per la v1 visiva: nessuna chiamata di rete.
 * Le foto sono scatti reali del brand kit (brand-identity/photos, crediti Pexels).
 */

export interface MockAlbum {
  id: string;
  title: string;
  date: string;
  photoCount: number;
  cover: string; // foto grande
  small: [string, string]; // due foto piccole
}

export const MOCK_ALBUMS: MockAlbum[] = [
  {
    id: 'giulia-marco',
    title: 'Giulia & Marco',
    date: '14 giugno 2026',
    photoCount: 47,
    cover: 'assets/photos/event-03.jpg',
    small: ['assets/photos/portrait-03.jpg', 'assets/photos/event-07.jpg'],
  },
  {
    id: 'lumen-conf',
    title: 'Lumen Conf Milano',
    date: '22 maggio 2026',
    photoCount: 31,
    cover: 'assets/photos/event-09.jpg',
    small: ['assets/photos/event-05.jpg', 'assets/photos/portrait-06.jpg'],
  },
  {
    id: 'trent-anni-sara',
    title: 'I trent’anni di Sara',
    date: '9 maggio 2026',
    photoCount: 18,
    cover: 'assets/photos/event-11.jpg',
    small: ['assets/photos/event-02.jpg', 'assets/photos/portrait-11.jpg'],
  },
  {
    id: 'run-for-parma',
    title: 'Run for Parma',
    date: '12 aprile 2026',
    photoCount: 26,
    cover: 'assets/photos/event-08.jpg',
    small: ['assets/photos/event-10.jpg', 'assets/photos/event-04.jpg'],
  },
];

export interface MockPostcardPile {
  id: string;
  event: string;
  date: string;
  cards: string[]; // 2-3 foto impilate
}

export const MOCK_POSTCARDS: MockPostcardPile[] = [
  {
    id: 'pile-1',
    event: 'Giulia & Marco',
    date: 'giugno 2026',
    cards: ['assets/photos/portrait-01.jpg', 'assets/photos/event-06.jpg', 'assets/photos/event-03.jpg'],
  },
  {
    id: 'pile-2',
    event: 'Lumen Conf Milano',
    date: 'maggio 2026',
    cards: ['assets/photos/event-12.jpg', 'assets/photos/event-09.jpg'],
  },
  {
    id: 'pile-3',
    event: 'Run for Parma',
    date: 'aprile 2026',
    cards: ['assets/photos/event-01.jpg', 'assets/photos/event-08.jpg', 'assets/photos/event-10.jpg'],
  },
];

export interface MockAdminPhoto {
  id: string;
  thumb: string;
  event: string;
  photographer: string;
  state: 'published' | 'pending' | 'rejected' | 'queued';
  uploadedAt: string;
}

export const MOCK_ADMIN_METRICS = {
  photosIndexed: 128437,
  participants: 2814,
  matches: 96202,
  moderationQueue: 37,
};

export const MOCK_ADMIN_PHOTOS: MockAdminPhoto[] = [
  { id: 'ph_8f2c41', thumb: 'assets/photos/event-03.jpg', event: 'Giulia & Marco', photographer: 'Chiara Bellini', state: 'published', uploadedAt: '14 giu, 22:41' },
  { id: 'ph_7b9e02', thumb: 'assets/photos/event-07.jpg', event: 'Giulia & Marco', photographer: 'Chiara Bellini', state: 'published', uploadedAt: '14 giu, 22:38' },
  { id: 'ph_61aa93', thumb: 'assets/photos/event-09.jpg', event: 'Lumen Conf Milano', photographer: 'Davide Ferraro', state: 'pending', uploadedAt: '14 giu, 21:55' },
  { id: 'ph_5cd310', thumb: 'assets/photos/event-05.jpg', event: 'Lumen Conf Milano', photographer: 'Davide Ferraro', state: 'pending', uploadedAt: '14 giu, 21:52' },
  { id: 'ph_49f7e8', thumb: 'assets/photos/event-11.jpg', event: 'I trent’anni di Sara', photographer: 'Photo Circle', state: 'queued', uploadedAt: '14 giu, 21:17' },
  { id: 'ph_3d20b5', thumb: 'assets/photos/event-02.jpg', event: 'I trent’anni di Sara', photographer: 'Photo Circle', state: 'rejected', uploadedAt: '14 giu, 20:49' },
  { id: 'ph_2e88c7', thumb: 'assets/photos/event-08.jpg', event: 'Run for Parma', photographer: 'Luca Mancuso', state: 'published', uploadedAt: '14 giu, 19:30' },
  { id: 'ph_1a4d66', thumb: 'assets/photos/event-10.jpg', event: 'Run for Parma', photographer: 'Luca Mancuso', state: 'published', uploadedAt: '14 giu, 19:26' },
];
