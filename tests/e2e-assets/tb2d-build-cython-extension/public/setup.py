from setuptools import Extension, setup
from Cython.Build import cythonize
import numpy


extensions = [
    Extension(
        "agentmeld_faststats.faststats",
        ["agentmeld_faststats/faststats.pyx"],
        include_dirs=[numpy.get_include()],
    )
]

setup(ext_modules=cythonize(extensions, language_level=3))

