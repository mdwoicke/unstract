from .local_storage import LocalStorageFS

__all__ = ["LocalStorageFS"]

metadata = {
    "name": LocalStorageFS.__name__,
    "version": "1.0.0",
    "connector": LocalStorageFS,
    "description": "LocalStorage connector",
    "is_active": True,
}
