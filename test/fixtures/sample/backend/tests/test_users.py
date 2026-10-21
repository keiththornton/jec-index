import pytest
from app.services.users import create_user

@pytest.mark.asyncio
async def test_create_user():
    assert await create_user("bob")
