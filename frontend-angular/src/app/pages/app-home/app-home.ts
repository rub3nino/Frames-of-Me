import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { MOCK_ALBUMS, MOCK_POSTCARDS } from '../../core/mock-data';

type GalleryView = 'album' | 'postcards';

@Component({
  selector: 'app-app-home',
  templateUrl: './app-home.html',
  styleUrl: './app-home.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AppHome {
  readonly view = signal<GalleryView>('album');
  readonly albums = MOCK_ALBUMS;
  readonly postcards = MOCK_POSTCARDS;

  setView(view: GalleryView): void {
    this.view.set(view);
  }
}
