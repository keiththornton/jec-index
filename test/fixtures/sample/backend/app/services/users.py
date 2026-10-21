from ..models import User, MAX_NAME
from app.db import get_session
import os.path as osp

async def create_user(name: str) -> User:
    if len(name) > MAX_NAME:
        raise ValueError("too long")
    session = get_session()
    return User(name)
