import {installExceptionCapture, flushPendingExceptions} from './system-exceptions.js';
installExceptionCapture({source: 'background'});
void flushPendingExceptions().catch(() => {});
