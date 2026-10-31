import {installExceptionCapture, flushPendingExceptions} from './system-exceptions.js';
installExceptionCapture({source: 'panel'});
void flushPendingExceptions().catch(() => {});
