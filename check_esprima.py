import sys
import esprima

def run():
    try:
        with open('data/app.js', 'r', encoding='utf-8') as f:
            code = f.read()
        ast = esprima.parseScript(code)
        print("No syntax errors found!")
    except Exception as e:
        print("Syntax error:", e)

if __name__ == "__main__":
    run()
