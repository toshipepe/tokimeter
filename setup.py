from setuptools import setup, find_packages

setup(
    name="tokimeter",
    version="0.2.0",
    description="FinOps for AI agents — track, attribute, and optimize LLM spend",
    packages=find_packages(),
    python_requires=">=3.9",
    entry_points={
        "console_scripts": [
            "tokimeter=tokimeter.cli:main",
            "tokimeter-hosted=tokimeter.hosted:main",
        ],
    },
)
