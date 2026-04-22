"""CLI entry point — starts the uvicorn server."""

import uvicorn


def main() -> None:
    """Start the dashboard server."""
    uvicorn.run(
        "roxabi_dashboard.app:app",
        host="127.0.0.1",
        port=8000,
        reload=False,
    )


if __name__ == "__main__":
    main()
