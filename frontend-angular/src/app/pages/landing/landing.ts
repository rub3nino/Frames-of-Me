import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { RevealDirective } from '../../shared/reveal.directive';
import { PecorellaComponent } from '../../shared/pecorella.component';

interface Sponsor {
  name: string;
  src: string;
}

@Component({
  selector: 'app-landing',
  imports: [RouterLink, RevealDirective, PecorellaComponent],
  templateUrl: './landing.html',
  styleUrl: './landing.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Landing {
  /** Loghi sponsor fittizi (SVG monocromi in assets/sponsor, sostituibili). */
  readonly sponsors: Sponsor[] = [
    { name: 'Nordwind', src: 'assets/sponsor/nordwind.svg' },
    { name: 'Caffè Aurora', src: 'assets/sponsor/caffe-aurora.svg' },
    { name: 'StudioLuce', src: 'assets/sponsor/studioluce.svg' },
    { name: 'Birrificio Ponte', src: 'assets/sponsor/birrificio-ponte.svg' },
    { name: 'Hotel Miramonti', src: 'assets/sponsor/miramonti.svg' },
    { name: 'Fioralba', src: 'assets/sponsor/fioralba.svg' },
    { name: 'Velotta', src: 'assets/sponsor/velotta.svg' },
    { name: 'Lumen Eventi', src: 'assets/sponsor/lumen-eventi.svg' },
  ];
}
