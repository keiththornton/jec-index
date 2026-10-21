MAX_NAME = 80

class User:
    def __init__(self, name: str):
        self.name = name

    def display(self) -> str:
        return self.name.title()

def _private_helper():
    return None
