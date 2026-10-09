import { Directive, ElementRef, OnDestroy, OnInit, inject } from '@angular/core';

/**
 * [appReveal] — rivelazione allo scroll: 480ms, una volta sola, IntersectionObserver.
 * Con prefers-reduced-motion l'elemento appare subito (solo dissolvenza, via CSS globale).
 */
@Directive({
  selector: '[appReveal]',
})
export class RevealDirective implements OnInit, OnDestroy {
  private readonly el = inject(ElementRef<HTMLElement>);
  private observer?: IntersectionObserver;

  ngOnInit(): void {
    const node = this.el.nativeElement as HTMLElement;
    node.classList.add('reveal');

    const reduced =
      typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (reduced || typeof IntersectionObserver === 'undefined') {
      node.classList.add('is-visible');
      return;
    }

    this.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            node.classList.add('is-visible');
            this.observer?.disconnect();
            this.observer = undefined;
          }
        }
      },
      { threshold: 0.12, rootMargin: '0px 0px -24px 0px' },
    );
    this.observer.observe(node);
  }

  ngOnDestroy(): void {
    this.observer?.disconnect();
  }
}
