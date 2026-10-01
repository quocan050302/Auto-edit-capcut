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
