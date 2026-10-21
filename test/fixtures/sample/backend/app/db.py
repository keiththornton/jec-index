import logging

logger = logging.getLogger(__name__)

def get_session():
    logger.info("session")
    return object()
