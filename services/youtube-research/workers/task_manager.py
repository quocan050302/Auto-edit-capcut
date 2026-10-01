import asyncio
import uuid
from typing import Dict, Any, Optional, Set
from datetime import datetime, timezone
import json

from core.logger import research_logger
from schemas.research_schemas import ProgressStateSchema

class TaskManager:
    def __init__(self):
        self.active_tasks: Dict[str, asyncio.Task] = {}
        self.cancellation_events: Dict[str, asyncio.Event] = {}
        self.progress_subscribers: Dict[str, Set[asyncio.Queue]] = {}
        self.latest_progress: Dict[str, ProgressStateSchema] = {}

    def create_run_id(self) -> str:
        return f"run_{uuid.uuid4().hex[:12]}"

    def register_run(self, run_id: str, task: asyncio.Task) -> None:
        self.active_tasks[run_id] = task
        self.cancellation_events[run_id] = asyncio.Event()
        task.add_done_callback(lambda t: self._handle_task_done(run_id, t))

    def _handle_task_done(self, run_id: str, completed_task: asyncio.Task) -> None:
        try:
            if completed_task.cancelled():
                research_logger.info(f"[TaskManager] Task {run_id} was cancelled.")
                self._ensure_terminal_state(run_id, stage="CANCELLED", message="Research task cancelled.")
                return

            exc = completed_task.exception()
            if exc:
                research_logger.error(f"[TaskManager] Task {run_id} finished with unhandled exception: {exc}", exc_info=exc)
                self._ensure_terminal_state(run_id, stage="FAILED", message=f"Task error: {str(exc)}", error=str(exc))
                return
        except Exception as err:
            research_logger.error(f"[TaskManager] Error in _handle_task_done for {run_id}: {err}")

    def _ensure_terminal_state(self, run_id: str, stage: str, message: str, error: Optional[str] = None) -> None:
        latest = self.latest_progress.get(run_id)
        if latest and latest.stage in ("COMPLETED", "FAILED", "CANCELLED", "INTERRUPTED"):
            return

        pct = 100 if stage == "COMPLETED" else (latest.progress_percent if latest else 0)
        videos_c = latest.videos_collected if latest else 0
        channels_a = latest.channels_analyzed if latest else 0
        keywords_e = latest.keywords_expanded if latest else 0

        try:
            from db.engine import SessionLocal
            from repositories.research_repo import ResearchRepository
            db = SessionLocal()
            try:
                repo = ResearchRepository(db)
                repo.update_run_stage(
                    run_id=run_id, 
                    stage=stage, 
                    progress_percent=pct, 
                    message=message, 
                    videos_collected=videos_c,
                    channels_analyzed=channels_a,
                    keywords_expanded=keywords_e,
                    error=error
                )
            finally:
                db.close()
        except Exception as e:
            research_logger.error(f"[TaskManager] Failed to persist terminal state {stage} for run {run_id}: {e}", exc_info=True)

        elapsed = latest.elapsed_seconds if latest else 0
        state = ProgressStateSchema(
            run_id=run_id,
            stage=stage,
            progress_percent=pct,
            message=message,
            videos_collected=videos_c,
            channels_analyzed=channels_a,
            keywords_expanded=keywords_e,
            elapsed_seconds=elapsed,
            can_cancel=False,
            error=error
        )
        self.latest_progress[run_id] = state
        if run_id in self.progress_subscribers:
            for q in list(self.progress_subscribers[run_id]):
                try:
                    q.put_nowait(state)
                except Exception:
                    pass

    def is_cancelled(self, run_id: str) -> bool:
        event = self.cancellation_events.get(run_id)
        return event.is_set() if event else False

    def cancel_run(self, run_id: str) -> bool:
        research_logger.info(f"[TaskManager] Cancelling run: {run_id}")
        if run_id in self.cancellation_events:
            self.cancellation_events[run_id].set()

        task = self.active_tasks.get(run_id)
        if task and not task.done():
            task.cancel()
            return True
        return False

    async def emit_progress(self, state: ProgressStateSchema) -> None:
        run_id = state.run_id
        self.latest_progress[run_id] = state

        if run_id in self.progress_subscribers:
            dead_queues = set()
            for q in self.progress_subscribers[run_id]:
                try:
                    q.put_nowait(state)
                except Exception:
                    dead_queues.add(q)
            for dq in dead_queues:
                self.progress_subscribers[run_id].remove(dq)

    def subscribe(self, run_id: str) -> asyncio.Queue:
        q = asyncio.Queue()
        if run_id not in self.progress_subscribers:
            self.progress_subscribers[run_id] = set()
        self.progress_subscribers[run_id].add(q)

        # Send latest state if available
        if run_id in self.latest_progress:
            q.put_nowait(self.latest_progress[run_id])

        return q

    def unsubscribe(self, run_id: str, q: asyncio.Queue) -> None:
        if run_id in self.progress_subscribers and q in self.progress_subscribers[run_id]:
            self.progress_subscribers[run_id].remove(q)

    def cleanup_run(self, run_id: str) -> None:
        self.active_tasks.pop(run_id, None)
        self.cancellation_events.pop(run_id, None)

task_manager = TaskManager()
