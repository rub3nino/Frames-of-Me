import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';

@Component({
  selector: 'app-staff',
  imports: [RouterLink],
  templateUrl: './staff.html',
  styleUrl: './staff.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Staff {}
