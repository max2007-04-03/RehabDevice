import re
import sys

def run():
    with open('data/app.js', 'r', encoding='utf-8') as f:
        content = f.read()

    # Fix event listeners with ?.
    content = re.sub(
        r'document\.getElementById\("([^"]+)"\)\?\.addEventListener',
        r'const \1_el = document.getElementById("\1");\n    if (\1_el) \1_el.addEventListener',
        content
    )
    
    # Fix tabDoctor in resize event
    content = content.replace('document.getElementById("tabDoctor")?.classList.contains("active")', '(document.getElementById("tabDoctor") && document.getElementById("tabDoctor").classList.contains("active"))')
    
    # Fix option selection
    content = content.replace('document.getElementById("doctorPatientSelect").options[document.getElementById("doctorPatientSelect").selectedIndex]?.text', '(document.getElementById("doctorPatientSelect").options[document.getElementById("doctorPatientSelect").selectedIndex] ? document.getElementById("doctorPatientSelect").options[document.getElementById("doctorPatientSelect").selectedIndex].text : "Пацієнт")')

    # Fix minAngle?.toFixed
    content = content.replace('rec.minAngle?.toFixed', '(rec.minAngle||0).toFixed')
    content = content.replace('rec.maxAngle?.toFixed', '(rec.maxAngle||0).toFixed')
    content = content.replace('rec.amplitude?.toFixed', '(rec.amplitude||0).toFixed')
    content = content.replace('rec.avgSpeed?.toFixed', '(rec.avgSpeed||0).toFixed')
    content = content.replace('rec.smoothness?.toFixed', '(rec.smoothness||0).toFixed')

    # Fix clientWidth / clientHeight
    content = content.replace('wrapper?.clientWidth', '(wrapper ? wrapper.clientWidth : 0)')
    content = content.replace('wrapper?.clientHeight', '(wrapper ? wrapper.clientHeight : 0)')

    with open('data/app.js', 'w', encoding='utf-8') as f:
        f.write(content)
    
    print("Done")

if __name__ == "__main__":
    run()
