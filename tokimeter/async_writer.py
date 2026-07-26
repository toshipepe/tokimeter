"""
Async batched writer for Tokimeter.

Buffers LLM call records in a thread-safe queue and flushes them to the
backend in batches on a background thread. This ensures tracking never
blocks the request thread or slows down your application.

Usage:
    writer = AsyncWriter(backend, flush_interval=2.0, batch_size=50)
    writer.start()
    writer.enqueue(call)  # non-blocking
    writer.stop()         # flush remaining + stop thread
"""

from __future__ import annotations

import atexit
import logging
import queue
import threading
import time
from typing import Optional

from .models import LLMCall

logger = logging.getLogger("tokimeter")


class AsyncWriter:
    """
    Background batched writer.

    - Enqueue calls are non-blocking (put_nowait on a bounded queue)
    - A daemon thread batches and flushes every flush_interval seconds
    - Graceful shutdown flushes remaining records via atexit
    """

    def __init__(
        self,
        backend,
        flush_interval: float = 2.0,
        batch_size: int = 50,
        queue_maxsize: int = 10000,
    ):
        self.backend = backend
        self.flush_interval = flush_interval
        self.batch_size = batch_size
        self._queue: queue.Queue[LLMCall | None] = queue.Queue(maxsize=queue_maxsize)
        self._thread: Optional[threading.Thread] = None
        self._stop_event = threading.Event()
        self._dropped = 0  # count of dropped records if queue is full
        self._flushed = 0  # total records successfully flushed
        self._errors = 0   # total flush errors

    def start(self):
        """Start the background flush thread."""
        if self._thread and self._thread.is_alive():
            return
        self._stop_event.clear()
        self._thread = threading.Thread(target=self._run, daemon=True, name="tokimeter-writer")
        self._thread.start()
        atexit.register(self.stop)
        logger.debug("AsyncWriter started (flush_interval=%ss, batch_size=%s)",
                      self.flush_interval, self.batch_size)

    def stop(self, timeout: float = 5.0):
        """Signal stop and wait for the thread to flush remaining records."""
        self._stop_event.set()
        self._queue.put(None)  # sentinel to wake up the thread
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=timeout)
        logger.debug("AsyncWriter stopped (flushed=%s, dropped=%s, errors=%s)",
                      self._flushed, self._dropped, self._errors)

    def enqueue(self, call: LLMCall) -> bool:
        """
        Enqueue a call for async batched writing.

        Returns True if enqueued, False if dropped (queue full).
        Never blocks or raises.
        """
        try:
            self._queue.put_nowait(call)
            return True
        except queue.Full:
            self._dropped += 1
            logger.warning("Tokimeter queue full, dropping call (dropped=%d)", self._dropped)
            return False

    def flush(self):
        """Manually trigger a flush of all queued records."""
        self._drain_queue()

    @property
    def pending(self) -> int:
        """Number of records waiting in the queue."""
        return self._queue.qsize()

    @property
    def stats(self) -> dict:
        """Writer statistics."""
        return {
            "pending": self.pending,
            "flushed": self._flushed,
            "dropped": self._dropped,
            "errors": self._errors,
        }

    def _run(self):
        """Main loop: wait for flush_interval or batch_size, then flush."""
        batch: list[LLMCall] = []
        last_flush = time.monotonic()

        while not self._stop_event.is_set() or not self._queue.empty():
            timeout = max(0.01, self.flush_interval - (time.monotonic() - last_flush))
            try:
                item = self._queue.get(timeout=timeout)
            except queue.Empty:
                # Timeout — flush if we have anything
                if batch:
                    self._flush_batch(batch)
                    batch = []
                    last_flush = time.monotonic()
                continue

            if item is None:
                # Sentinel — flush and exit
                if batch:
                    self._flush_batch(batch)
                break

            batch.append(item)

            if len(batch) >= self.batch_size:
                self._flush_batch(batch)
                batch = []
                last_flush = time.monotonic()

        # Final flush
        if batch:
            self._flush_batch(batch)

    def _drain_queue(self):
        """Drain everything currently in the queue."""
        batch: list[LLMCall] = []
        while True:
            try:
                item = self._queue.get_nowait()
                if item is None:
                    continue
                batch.append(item)
                if len(batch) >= self.batch_size:
                    self._flush_batch(batch)
                    batch = []
            except queue.Empty:
                break
        if batch:
            self._flush_batch(batch)

    def _flush_batch(self, batch: list[LLMCall]):
        """Flush a batch of records to the backend with retry."""
        max_retries = 3
        for attempt in range(max_retries):
            try:
                self.backend.record_calls(batch)
                self._flushed += len(batch)
                logger.debug("Flushed %d records (total=%d)", len(batch), self._flushed)
                return
            except Exception as e:
                if attempt < max_retries - 1:
                    wait = 0.5 * (2 ** attempt)
                    logger.warning("Flush attempt %d failed: %s, retrying in %ss",
                                   attempt + 1, e, wait)
                    time.sleep(wait)
                else:
                    self._errors += len(batch)
                    logger.error("Flush failed after %d attempts, dropping %d records: %s",
                                 max_retries, len(batch), e)
