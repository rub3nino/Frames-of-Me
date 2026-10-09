import { ChangeDetectionStrategy, Component } from '@angular/core';
import { MOCK_ADMIN_METRICS, MOCK_ADMIN_PHOTOS } from '../../core/mock-data';

// useGrouping 'always': il CLDR it-IT raggruppa solo da 5 cifre (2814 → "2814"),
// ma il brand chiede il formato it-IT con separatore sempre ("2.814").
// (cast: il lib TS corrente tipizza useGrouping solo come boolean)
const nf = new Intl.NumberFormat('it-IT', { useGrouping: 'always' } as unknown as Intl.NumberFormatOptions);

interface MetricCard {
  label: string;
  value: string;
}

const STATE_LABEL: Record<string, string> = {
  published: 'Pubblicata',
  pending: 'In moderazione',
  rejected: 'Rifiutata',
  queued: 'In coda',
};

@Component({
  selector: 'app-admin',
  templateUrl: './admin.html',
  styleUrl: './admin.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Admin {
  readonly navItems = [
    { label: 'Stato', icon: 'pulse' },
    { label: 'Eventi', icon: 'calendar' },
    { label: 'Foto', icon: 'image' },
    { label: 'Gallerie', icon: 'layers' },
    { label: 'Moderazione', icon: 'check' },
    { label: 'Export', icon: 'download' },
    { label: 'Impostazioni', icon: 'settings' },
  ];

  readonly active = 'Foto';

  readonly metrics: MetricCard[] = [
    { label: 'Foto indicizzate', value: nf.format(MOCK_ADMIN_METRICS.photosIndexed) },
    { label: 'Partecipanti', value: nf.format(MOCK_ADMIN_METRICS.participants) },
    { label: 'Match trovati', value: nf.format(MOCK_ADMIN_METRICS.matches) },
    { label: 'In coda di moderazione', value: nf.format(MOCK_ADMIN_METRICS.moderationQueue) },
  ];

  readonly photos = MOCK_ADMIN_PHOTOS;

  stateLabel(state: string): string {
    return STATE_LABEL[state] ?? state;
  }
}
