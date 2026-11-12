import type { AtelierApi } from './index';

declare global {
  interface Window {
    atelier: AtelierApi;
  }
}

export {};
