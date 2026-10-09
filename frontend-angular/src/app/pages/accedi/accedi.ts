import { ChangeDetectionStrategy, Component, computed, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { PecorellaComponent } from '../../shared/pecorella.component';

type LoginRole = 'participant' | 'photographer';

@Component({
  selector: 'app-accedi',
  imports: [RouterLink, PecorellaComponent],
  templateUrl: './accedi.html',
  styleUrl: './accedi.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Accedi {
  readonly role = signal<LoginRole>('participant');

  readonly title = computed(() =>
    this.role() === 'participant' ? 'Ritrova le tue foto' : 'Carica gli scatti dell’evento',
  );

  readonly subtitle = computed(() =>
    this.role() === 'participant'
      ? 'Entra e apri la galleria degli eventi a cui hai partecipato.'
      : 'Entra nel tuo spazio da fotografo: upload, eventi e consegne.',
  );

  setRole(role: LoginRole): void {
    this.role.set(role);
  }
}
